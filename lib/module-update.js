import { StorageManager } from "./storage.js";
import { SpikeApiClient } from "./spike-client.js";
import { MODULE_UPDATE_STATUSES } from "./control-api-contract.js";
import { msg } from "./i18n.js";

const starts = new Map();
const polls = new Map();
const legacyOperations = new Map();
const activeStatuses = new Set(["submitting", "running"]);
const terminalStatuses = new Set(["succeeded", "failed", "rejected", "dismissed"]);
const failures = {
  get busy() { return msg("popup.moduleUpdateRunningRequest"); },
  get unknown() { return msg("popup.moduleUpdateOutcomeUnknown"); },
  get query() { return msg("common.moduleTaskQueryFailed"); },
  get failed() { return msg("popup.moduleUpdateFailedInspect"); },
  get changed() { return msg("popup.instanceConnectionChangedOriginal"); },
  get rejected() { return msg("popup.moduleUpdateRequestNot"); },
};

async function target(instanceId) {
  const instance = (await StorageManager.getInstances()).find((item) => item.id === instanceId);
  if (!instance) throw new Error(msg("popup.noSpikeInstanceConfigured"));
  const fixed = { id: instance.id, baseUrl: instance.baseUrl, secret: instance.secret };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(fixed)),
  );
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return { instance: fixed, fingerprint };
}

function publish(task) {
  if (!task) return;
  void chrome.runtime
    .sendMessage({ type: "MODULE_UPDATE_CHANGED", instanceId: task.instanceId, task })
    .catch(() => {});
}

async function commit(instanceId, expected, next) {
  const result = await StorageManager.updateModuleUpdateTask(instanceId, (current) => {
    if (current?.id !== expected?.id || current?.sequence !== expected?.sequence) return;
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    return next;
  });
  if (result?.sequence !== expected?.sequence) publish(result);
  return result;
}

function fromCore(core, instanceId, fingerprint, previous) {
  if (
    !core ||
    core.schema_version !== 1 ||
    typeof core.id !== "string" ||
    !core.task_namespace ||
    !MODULE_UPDATE_STATUSES.includes(core.status)
  ) {
    throw new Error("invalid module task response");
  }
  return {
    id: core.id,
    instanceId,
    instanceFingerprint: fingerprint,
    mode: "core",
    taskNamespace: core.task_namespace,
    status: core.status,
    startedAtUnixMs: core.started_at_unix_ms,
    finishedAtUnixMs: core.completed_at_unix_ms || null,
    error: core.status === "failed" ? failures.failed : null,
    error_code: core.status === "failed" ? core.error_code : undefined,
    sequence: previous?.sequence,
  };
}

// The live status carries Core's detail, while persistent task references
// keep only the stable code and generic text.
function withCoreFailure(task, core) {
  if (task?.id !== core.id || task?.taskNamespace !== core.task_namespace ||
      task.status !== "failed" || core.status !== "failed") return task;
  return { ...task, error: core.error || task.error };
}

function result(task, error = null, canDismiss = false) {
  return { task: task?.status === "dismissed" ? null : task, error, canDismiss };
}

async function reconcile(instanceId) {
  const { instance, fingerprint } = await target(instanceId);
  const saved = await StorageManager.getModuleUpdateTask(instanceId);
  if (legacyOperations.has(instanceId) && saved?.instanceFingerprint === fingerprint)
    return result(saved);
  try {
    const data = await SpikeApiClient.getModuleUpdateTasks(instance);
    if (data?.schema_version !== 1 || !data.task_namespace || !Array.isArray(data.tasks))
      throw new Error("invalid task list");
    if (saved && saved.status !== "dismissed" && saved.instanceFingerprint !== fingerprint) {
      return result(
        await commit(instanceId, saved, { ...saved, status: "unknown", error: failures.changed }),
        null,
        !legacyOperations.has(instanceId) && !data.tasks.some((task) => task.status === "running"),
      );
    }
    const matched =
      saved?.instanceFingerprint === fingerprint && saved.taskNamespace === data.task_namespace
        ? data.tasks.find((task) => task.id === saved.id)
        : null;
    const current = data.tasks.find((task) => task.status === "running") || matched;
    if (current) {
      if (current.task_namespace !== data.task_namespace)
        throw new Error("inconsistent task namespace");
      const next = fromCore(current, instanceId, fingerprint, saved);
      const stored = await commit(instanceId, saved, next);
      return result(withCoreFailure(stored, current));
    }
    if (saved && !terminalStatuses.has(saved.status)) {
      const next = { ...saved, status: "unknown", error: failures.unknown };
      return result(await commit(instanceId, saved, next), null, true);
    }
    return result(saved);
  } catch (error) {
    if (error?.status === 404) {
      // Legacy inventory is only a reachability check, never proof of task completion.
      try {
        const inventory = await SpikeApiClient.getModules(instance);
        if (inventory?.error || !Array.isArray(inventory?.modules))
          throw new Error("module inventory unavailable");
        if (saved && saved.status !== "dismissed" && saved.instanceFingerprint !== fingerprint) {
          return result(
            await commit(instanceId, saved, {
              ...saved,
              status: "unknown",
              error: failures.changed,
            }),
            null,
            !legacyOperations.has(instanceId),
          );
        }
        if (saved && !terminalStatuses.has(saved.status)) {
          return result(
            await commit(instanceId, saved, {
              ...saved,
              status: "unknown",
              error: failures.unknown,
            }),
            null,
            true,
          );
        }
        return result(saved);
      } catch {
        return result(saved, failures.query);
      }
    }
    return result(saved, failures.query);
  }
}

function poll(instanceId) {
  if (polls.has(instanceId)) return polls.get(instanceId);
  const operation = reconcile(instanceId).finally(() => {
    if (polls.get(instanceId) === operation) polls.delete(instanceId);
  });
  polls.set(instanceId, operation);
  return operation;
}

export async function getModuleUpdateState(instanceId) {
  // Never reclassify an in-flight submission as a lost task before its POST settles.
  if (starts.has(instanceId)) await starts.get(instanceId).catch(() => {});
  return await poll(instanceId);
}

export function startModuleUpdate(instanceId, changes) {
  if (starts.has(instanceId) || legacyOperations.has(instanceId))
    return Promise.reject(new Error(failures.busy));
  const operation = start(instanceId, changes).finally(() => {
    if (starts.get(instanceId) === operation) starts.delete(instanceId);
  });
  starts.set(instanceId, operation);
  return operation;
}

async function start(instanceId, changes) {
  const state = await poll(instanceId);
  if (state.error) throw new Error(state.error);
  if (activeStatuses.has(state.task?.status)) throw new Error(failures.busy);
  if (state.task?.status === "unknown") throw new Error(failures.unknown);
  const { instance, fingerprint } = await target(instanceId);
  let namespace = null;
  let data;
  try {
    data = await SpikeApiClient.getModuleUpdateTasks(instance);
  } catch (error) {
    if (error?.status !== 404) throw new Error(failures.query);
  }
  if (data) {
    if (data.schema_version !== 1 || !data.task_namespace || !Array.isArray(data.tasks))
      throw new Error(failures.query);
    if (data.tasks.some((task) => task.status === "running")) throw new Error(failures.busy);
    namespace = data.task_namespace;
  }
  const previous = await StorageManager.getModuleUpdateTask(instanceId);
  const proposed = {
    id: crypto.randomUUID(),
    instanceId,
    instanceFingerprint: fingerprint,
    mode: namespace ? "core" : "legacy",
    taskNamespace: namespace,
    status: "submitting",
    startedAtUnixMs: Date.now(),
    finishedAtUnixMs: null,
    error: null,
  };
  const task = await commit(instanceId, previous, proposed);
  if (task?.id !== proposed.id) throw new Error(failures.busy);
  if (!namespace) {
    const running = await commit(instanceId, task, { ...task, status: "running" });
    const operation = runLegacy(instance, running, changes).finally(() => {
      if (legacyOperations.get(instanceId) === operation) legacyOperations.delete(instanceId);
    });
    legacyOperations.set(instanceId, operation);
    void operation.catch(() => {});
    return running;
  }
  let accepted;
  try {
    accepted = await SpikeApiClient.startModuleUpdateTask(instance, task, changes);
  } catch (error) {
    const rejected = [400, 401, 403, 404, 409, 422].includes(error?.status);
    const next = await commit(instanceId, task, {
      ...task,
      status: rejected ? "rejected" : "unknown",
      error: rejected ? failures.rejected : failures.unknown,
    });
    if (rejected) throw error?.coreMessage ? error : new Error(failures.rejected);
    return next;
  }
  if (accepted?.id !== task.id || accepted?.task_namespace !== task.taskNamespace) {
    return await commit(instanceId, task, { ...task, status: "unknown", error: failures.unknown });
  }
  // A storage error after acceptance must retain the pre-POST reference, not report Core failure.
  let next;
  try {
    next = fromCore(accepted, instanceId, fingerprint, task);
  } catch {
    return await commit(instanceId, task, { ...task, status: "unknown", error: failures.unknown });
  }
  return withCoreFailure(await commit(instanceId, task, next), accepted);
}

async function runLegacy(instance, task, changes) {
  let next;
  try {
    const response = await SpikeApiClient.updateModules(instance, changes);
    next =
      response?.ok === true
        ? { ...task, status: "succeeded", error: null }
        : {
            ...task,
            status: response?.error ? "failed" : "unknown",
            error: response?.error ? failures.failed : failures.unknown,
          };
  } catch (error) {
    const rejected = [400, 401, 403, 404, 409, 422].includes(error?.status);
    next = {
      ...task,
      status: rejected ? "failed" : "unknown",
      error: rejected ? failures.failed : failures.unknown,
    };
  }
  await commit(instance.id, task, { ...next, finishedAtUnixMs: Date.now() });
}

export async function dismissUnknownModuleUpdate(instanceId, taskId, sequence) {
  const state = await getModuleUpdateState(instanceId);
  if (
    state.error ||
    !state.canDismiss ||
    state.task?.status !== "unknown" ||
    state.task.id !== taskId ||
    state.task.sequence !== sequence
  ) {
    throw new Error(state.error || msg("popup.moduleTaskStateChanged"));
  }
  const cleared = await commit(instanceId, state.task, { ...state.task, status: "dismissed" });
  if (cleared?.id !== taskId || cleared.status !== "dismissed") {
    throw new Error(msg("popup.moduleTaskStateChanged"));
  }
  return result(cleared);
}

import { StorageManager } from "./storage.js";
import { SpikeApiClient } from "./spike-client.js";
import { preferredProxyEndpoint, proxyListenersFromStatus } from "./proxy-listeners.js";

let version = 0;
let readSequence = 0;
let intent = null;
let activeJob = null;
let writes = Promise.resolve();
const superseded = () => ({
  action: "superseded",
  mode: "superseded",
  healthy: null,
  superseded: true,
});

function sameIntent(left, right) {
  return (
    Boolean(left && right) &&
    left.enabled === right.enabled &&
    left.instance?.id === right.instance?.id &&
    left.instance?.baseUrl === right.instance?.baseUrl &&
    left.instance?.secret === right.instance?.secret
  );
}

export function invalidateProxyIntent() {
  version += 1;
  readSequence += 1;
  intent = null;
}

function isCurrent(job) {
  return job.version === version && sameIntent(job.intent, intent);
}

async function canCommit(job) {
  if (!isCurrent(job)) return false;
  const stored = await StorageManager.getProxyIntent();
  return isCurrent(job) && sameIntent(job.intent, stored);
}

function matchesConfiguration(value, expected) {
  const actual = value?.rules?.singleProxy;
  const wanted = expected.rules.singleProxy;
  return (
    value?.mode === "fixed_servers" &&
    actual?.scheme === wanted.scheme &&
    actual?.host === wanted.host &&
    actual?.port === wanted.port &&
    Object.keys(value.rules).every((key) => ["singleProxy", "bypassList"].includes(key)) &&
    JSON.stringify(value.rules.bypassList || []) === JSON.stringify(expected.rules.bypassList)
  );
}

export async function getProxyControlState() {
  const setting = await chrome.proxy.settings.get({ incognito: false });
  return {
    levelOfControl: setting.levelOfControl,
    controlledBySpikeDeck: setting.levelOfControl === "controlled_by_this_extension",
    releasedForUnhealthy: await StorageManager.isProxyReleasedForUnhealthy(),
  };
}

async function publishState(job, released) {
  await StorageManager.setProxyReleasedForUnhealthy(released);
  if (!isCurrent(job)) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: released ? "#EF4444" : "#6366F1" });
    await chrome.action.setBadgeText({ text: released ? "ERR" : job.intent.enabled ? "ON" : "" });
    await chrome.action.setTitle?.({
      title: released
        ? "SpikeDeck · Spike unreachable, proxy released"
        : job.intent.enabled
          ? "SpikeDeck · proxy on"
          : "SpikeDeck",
    });
  } catch (error) {
    // A presentation failure must not undo a valid proxy setting.
    console.warn("Proxy badge update failed:", error);
  }
}

async function releaseSetting() {
  await chrome.proxy.settings.clear({ scope: "regular" });
  const setting = await chrome.proxy.settings.get({ incognito: false });
  if (setting.levelOfControl === "controlled_by_this_extension") {
    throw new Error("Chrome did not release the extension proxy setting");
  }
}

async function commit(job, endpoint, error) {
  if (!(await canCommit(job))) return superseded();
  try {
    if (error) throw error;
    if (!job.intent.enabled) {
      // Clear only our extension's setting, never replace another owner's value.
      await releaseSetting();
      if (!isCurrent(job)) return superseded();
      await publishState(job, false);
      if (!isCurrent(job)) return superseded();
      return { action: "idle", mode: "released", healthy: null, ...(await getProxyControlState()) };
    }

    const config = {
      mode: "fixed_servers",
      rules: {
        singleProxy: { scheme: endpoint.scheme, host: endpoint.host, port: endpoint.port },
        bypassList: ["127.0.0.1", "localhost", "::1"],
      },
    };
    let setting = await chrome.proxy.settings.get({ incognito: false });
    if (!isCurrent(job)) return superseded();
    const holding =
      setting.levelOfControl === "controlled_by_this_extension" &&
      matchesConfiguration(setting.value, config);
    if (!holding) {
      await chrome.proxy.settings.set({ value: config, scope: "regular" });
      if (!isCurrent(job)) return superseded();
      setting = await chrome.proxy.settings.get({ incognito: false });
      if (
        setting.levelOfControl !== "controlled_by_this_extension" ||
        !matchesConfiguration(setting.value, config)
      ) {
        throw new Error(
          "Chrome did not apply the requested proxy endpoint; another extension or policy may control it",
        );
      }
    }
    if (!isCurrent(job)) return superseded();
    await publishState(job, false);
    if (!isCurrent(job)) return superseded();
    return {
      action: holding ? "holding" : "restored",
      mode: "fixed_servers",
      healthy: true,
      ...endpoint,
      ...(await getProxyControlState()),
    };
  } catch (failure) {
    // Error recovery is a write too. An obsolete failure must not clear a newer route.
    if (!(await canCommit(job))) return superseded();
    try {
      await releaseSetting();
      if (!isCurrent(job)) return superseded();
      await publishState(job, job.intent.enabled);
    } catch (clearError) {
      if (!isCurrent(job)) return superseded();
      return {
        action: "error",
        mode: "error",
        healthy: false,
        error: `${failure.message}; proxy release failed: ${clearError.message}`,
      };
    }
    if (!isCurrent(job)) return superseded();
    return {
      action: "released",
      mode: "released",
      healthy: false,
      error: failure.message,
      ...(await getProxyControlState()),
    };
  }
}

async function execute(job, timeoutMs) {
  let endpoint;
  let error;
  try {
    if (job.intent.enabled) {
      if (!job.intent.instance) throw new Error("No active Spike instance");
      const status = await SpikeApiClient.getStatus(job.intent.instance, { timeoutMs });
      endpoint = preferredProxyEndpoint(proxyListenersFromStatus(status, job.intent.instance));
      if (!endpoint)
        throw new Error("Spike /spike/status did not expose a usable HTTP or SOCKS listener");
    }
  } catch (failure) {
    error = failure;
  }
  const write = writes.then(() => commit(job, endpoint, error));
  writes = write.catch(() => {});
  const result = await write;
  return isCurrent(job) ? result : superseded();
}

export async function reconcileProxyIntent({ timeoutMs = 2500 } = {}) {
  const read = ++readSequence;
  const stored = await StorageManager.getProxyIntent();
  if (read !== readSequence) return superseded();
  if (!sameIntent(intent, stored)) {
    version += 1;
    intent = stored;
  }
  if (activeJob?.pending && isCurrent(activeJob)) return activeJob.promise;
  const job = { version, intent: stored, pending: true };
  activeJob = job;
  job.promise = execute(job, timeoutMs).finally(() => {
    job.pending = false;
  });
  return job.promise;
}

import { GroupTestBatch } from "./group-batch.js";
import { SpikeApiClient } from "./spike-client.js";
import { getCurrentLanguage, translateForLanguage } from "./i18n.js";

export class GroupBatchControls {
  constructor({
    document,
    scope,
    names,
    active,
    record,
    changed,
    send = (message) => chrome.runtime.sendMessage(message),
    confirm = (text) => window.confirm(translateForLanguage(text, getCurrentLanguage())),
  }) {
    this.scope = scope;
    this.names = names;
    this.active = active;
    this.record = record;
    this.changed = changed;
    this.send = send;
    this.confirm = confirm;
    this.revision = null;
    this.session = null;
    this.elements = Object.fromEntries(
      ["start", "cancel", "retry", "forget", "reload", "status"].map((name) => [
        name,
        document.getElementById(`group-batch-${name}`),
      ]),
    );
    this.elements.start.addEventListener("click", () => this.session?.start(this.names()));
    this.elements.cancel.addEventListener("click", () => void this.session?.cancel());
    this.elements.retry.addEventListener("click", () => void this.session?.poll());
    this.elements.reload.addEventListener("click", () => void this.session?.load());
    this.elements.forget.addEventListener("click", () => {
      if (this.confirm("停止观察此批测试？已接受的测试可能继续在引擎中运行。"))
        this.session?.forget();
    });
    this.render();
  }

  get reserved() {
    return this.session?.reserved || [];
  }

  reset() {
    this.session?.dispose();
    this.session = null;
    this.revision = null;
    this.render();
    this.changed();
  }

  observeRevision(revision) {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      this.reset();
      return;
    }
    if (revision === this.revision) return;
    this.reset();
    this.revision = revision;
    const scope = this.scope();
    if (!scope.instance) return;
    const read = async (operation) => {
      if (!scope.isCurrent()) throw new Error("Retired group observation");
      let namespace = null;
      const value = await operation((value) => {
        namespace = value;
      });
      return { value, namespace };
    };
    const mutation = async (type, namespace, data) => {
      if (type === "START_GROUP_TEST" && !scope.isCurrent())
        throw new Error("Retired group observation");
      const response = await this.send({
        type,
        instanceId: scope.instance.id,
        runtimeNamespace: namespace,
        ...data,
      });
      if (!response?.ok || (response.mode && response.mode !== "async"))
        throw new Error("Unconfirmed group operation");
      return { value: response.task, namespace: response.runtimeNamespace || null };
    };
    this.session = new GroupTestBatch(
      {
        context: () => read((onRuntime) => SpikeApiClient.getGroups(scope.instance, { onRuntime })),
        start: (group, namespace) => mutation("START_GROUP_TEST", namespace, { groupName: group }),
        get: (id, namespace) =>
          read((onRuntime) =>
            SpikeApiClient.getGroupTestTask(scope.instance, id, {
              runtimeNamespace: namespace,
              onRuntime,
            }),
          ),
        cancel: (id, namespace) => mutation("CANCEL_GROUP_TEST", namespace, { taskId: id }),
        active: (group) => this.active(group),
        record: (task) => {
          if (scope.isCurrent()) this.record(task);
        },
      },
      revision,
      () => {
        this.render();
        this.changed();
      },
    );
    void this.session.load();
  }

  render() {
    const state = this.session,
      ui = this.elements;
    ui.start.disabled = !state?.ready || state.running || this.names().length === 0;
    ui.cancel.hidden = !state?.running;
    ui.cancel.disabled = Boolean(state?.cancelling);
    ui.retry.hidden = !state?.paused || !state.task;
    ui.retry.disabled = Boolean(state?.reading || state?.cancelling);
    ui.forget.hidden = !state?.paused;
    ui.forget.disabled = Boolean(state?.starting || state?.reading || state?.cancelling);
    ui.reload.hidden = Boolean(state?.running);
    ui.reload.disabled = !state || state.reading;
    ui.status.replaceChildren();
    if (state?.total) {
      const progress = ui.status.ownerDocument.createElement("span");
      progress.textContent = `${state.done} / ${state.total}`;
      progress.setAttribute("data-i18n-ignore", "");
      ui.status.appendChild(progress);
    }
    if (state?.reading && !state.running) {
      const loading = ui.status.ownerDocument.createElement("span");
      loading.textContent = "正在读取组目录…";
      ui.status.appendChild(loading);
    }
    if (state?.message) {
      const message = ui.status.ownerDocument.createElement("span");
      message.textContent = state.message;
      ui.status.appendChild(message);
    }
  }
}

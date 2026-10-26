function shouldAcceptGroupTask(previous, incoming) {
  if (!previous) return true;
  const before = previous.update_sequence || 0,
    after = incoming.update_sequence || 0;
  return before || after ? after >= before : incoming.completed >= previous.completed;
}

const terminal = (task) => ["completed", "failed", "cancelled"].includes(task.status);

/** One active group at a time; retries only observe accepted task identities. */
export class GroupTestBatch {
  api;
  changed;
  revision;
  live = true;
  namespace = null;
  known = new Set();
  queue = [];
  timer;
  currentGroup = "";
  failures = 0;
  cancelSent = false;
  task = null;
  ready = false;
  reading = false;
  starting = false;
  cancelling = false;
  cancelRequested = false;
  paused = false;
  done = 0;
  total = 0;
  message = "";

  constructor(api, revision, changed) {
    this.api = api;
    this.revision = revision;
    this.changed = changed;
  }
  get reserved() {
    return this.currentGroup ? [this.currentGroup, ...this.queue] : this.queue;
  }
  get running() {
    return this.reserved.length > 0;
  }
  notify() {
    if (this.live) this.changed();
  }
  clearTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
  dispose() {
    this.live = false;
    this.queue = [];
    this.clearTimer();
  }

  async load() {
    if (!this.live || this.reading || this.running) return;
    this.reading = true;
    this.ready = false;
    this.message = "";
    this.notify();
    try {
      const result = await this.api.context();
      if (!this.live) return;
      if (!result.namespace || result.value.revision !== this.revision)
        throw new Error("context changed");
      this.namespace = result.namespace;
      this.known = new Set(result.value.groups.map((group) => group.name));
      this.ready = true;
    } catch {
      if (this.live)
        this.message = "Could not bind batch tests to this runtime. Reload the group catalog.";
    } finally {
      this.reading = false;
      this.notify();
    }
  }

  start(names) {
    if (!this.live || !this.ready || this.running || this.reading) return;
    if (names.some((name) => !this.known.has(name))) {
      this.ready = false;
      this.message = "Could not bind batch tests to this runtime. Reload the group catalog.";
      this.notify();
      return;
    }
    this.queue = [...new Set(names)].filter((name) => !this.api.active(name));
    this.total = this.queue.length;
    this.done = 0;
    this.cancelRequested = false;
    this.cancelSent = false;
    this.failures = 0;
    this.paused = false;
    this.message = "";
    void this.advance();
  }

  sameReceipt(result) {
    return (
      result.namespace === this.namespace &&
      result.value.revision === this.revision &&
      result.value.group === this.currentGroup &&
      Number.isSafeInteger(result.value.id) &&
      result.value.id > 0
    );
  }
  accept(result) {
    if (!this.sameReceipt(result)) {
      this.clearTimer();
      this.queue = [];
      this.currentGroup = "";
      this.task = null;
      this.ready = false;
      this.message = "Batch runtime changed. Reload the group catalog before testing.";
      this.notify();
      return false;
    }
    if (
      this.task &&
      (this.task.id !== result.value.id ||
        this.task.created_at_unix_ms !== result.value.created_at_unix_ms ||
        this.task.task_namespace !== result.value.task_namespace)
    ) {
      this.paused = true;
      this.message = "Unable to confirm this group test. Retry status or stop observing.";
      this.notify();
      return false;
    }
    if (
      !(this.task && terminal(this.task) && !terminal(result.value)) &&
      shouldAcceptGroupTask(this.task ?? undefined, result.value)
    ) {
      this.task = result.value;
      this.api.record(result.value);
    }
    return true;
  }

  async advance() {
    if (
      !this.live ||
      !this.namespace ||
      this.starting ||
      this.reading ||
      this.cancelling ||
      this.paused
    )
      return;
    if (this.task && !terminal(this.task)) return;
    this.task = null;
    this.currentGroup = "";
    while (this.queue.length) {
      const group = this.queue.shift();
      if (this.api.active(group)) {
        this.done += 1;
        continue;
      }
      this.currentGroup = group;
      break;
    }
    if (!this.currentGroup) {
      this.notify();
      return;
    }
    this.starting = true;
    this.failures = 0;
    this.notify();
    try {
      const result = await this.api.start(this.currentGroup, this.namespace);
      if (!this.live) {
        if (this.cancelRequested && this.sameReceipt(result)) {
          try {
            await this.api.cancel(result.value.id, this.namespace);
          } catch {
            /* The retired observer cannot report a receipt. */
          }
        }
        return;
      }
      if (!this.accept(result)) return;
    } catch {
      if (!this.live) return;
      this.paused = true;
      this.message = "Group test start is unconfirmed. Check recent tasks before starting again.";
    } finally {
      this.starting = false;
      this.notify();
    }
    if (!this.live || this.paused || !this.task) return;
    if (this.cancelRequested) await this.cancel();
    else this.follow();
  }

  follow() {
    if (!this.live || !this.task || this.paused) return;
    this.clearTimer();
    if (terminal(this.task)) {
      this.done += 1;
      this.currentGroup = "";
      this.task = null;
      void this.advance();
    } else this.timer = setTimeout(() => void this.poll(), 700);
    this.notify();
  }

  async poll() {
    if (
      !this.live ||
      !this.task ||
      !this.namespace ||
      this.reading ||
      this.cancelling ||
      this.starting
    )
      return;
    this.clearTimer();
    this.reading = true;
    this.paused = false;
    this.message = "";
    this.notify();
    try {
      const result = await this.api.get(this.task.id, this.namespace);
      if (!this.live || !this.accept(result)) return;
      this.failures = 0;
    } catch {
      if (!this.live) return;
      this.failures += 1;
      this.paused = this.failures >= 3;
      if (this.paused)
        this.message = "Unable to confirm this group test. Retry status or stop observing.";
    } finally {
      this.reading = false;
      this.notify();
    }
    if (this.cancelRequested && !this.cancelSent) await this.cancel();
    else this.follow();
  }

  async cancel() {
    if (!this.live || this.cancelling) return;
    this.queue = [];
    this.cancelRequested = true;
    this.clearTimer();
    this.notify();
    if (!this.task || !this.namespace || this.starting || this.reading) return;
    this.cancelling = true;
    this.paused = false;
    try {
      const result = await this.api.cancel(this.task.id, this.namespace);
      if (!this.live || !this.accept(result)) return;
      this.message = "";
      this.failures = 0;
      this.cancelSent = true;
    } catch {
      if (!this.live) return;
      this.paused = true;
      this.message = "Unable to confirm cancellation. Retry Cancel or inspect task status.";
    } finally {
      this.cancelling = false;
      this.notify();
    }
    this.follow();
  }

  forget() {
    if (!this.live || this.starting || this.reading || this.cancelling) return;
    this.clearTimer();
    this.queue = [];
    this.currentGroup = "";
    this.task = null;
    this.paused = false;
    this.ready = false;
    this.message = "";
    this.notify();
  }
}

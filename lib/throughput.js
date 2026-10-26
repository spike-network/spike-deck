export const throughputFinished = task => ['completed', 'cancelled', 'failed'].includes(task.status);
const valid = task => Number.isSafeInteger(task?.id) && task.id > 0 && Number.isSafeInteger(task.created_at_unix_ms) &&
  ['queued', 'running', 'completed', 'cancelled', 'failed'].includes(task.status);
const same = (a, b) => a.id === b.id && a.created_at_unix_ms === b.created_at_unix_ms &&
  a.revision === b.revision && a.policy === b.policy && a.direction === b.direction;

export class ThroughputSession {
  constructor(api, changed) {
    Object.assign(this, { api, changed, tasks: [], task: null, namespace: '', reading: false, starting: false,
      cancelling: false, polling: false, cancelRequested: false, uncertain: false, error: '',
      live: true, generation: 0, readVersion: 0, timer: null });
  }
  get busy() { return this.starting || this.uncertain || Boolean(this.task && !throughputFinished(this.task)); }
  current(generation) { return this.live && generation === this.generation; }
  accept(task) {
    const current = this.task;
    if (current && same(current, task) && (
      throughputFinished(current) && !throughputFinished(task) || current.bytes > task.bytes ||
      current.status === 'running' && task.status === 'queued' ||
      current.cancel_requested && !task.cancel_requested && !throughputFinished(task))) task = current;
    this.task = task;
    this.tasks = this.tasks.map(item => same(item, task) ? task : item);
  }
  dispose() { this.live = false; this.generation++; clearTimeout(this.timer); }
  schedule() {
    clearTimeout(this.timer);
    if (this.live && this.task && !throughputFinished(this.task)) this.timer = setTimeout(() => void this.check(), 500);
  }
  async load() {
    if (!this.live || this.reading || this.starting || this.cancelling) return;
    this.reading = true; this.error = ''; this.changed(); const generation = this.generation;
    try {
      const result = await this.api.list();
      if (!this.current(generation)) return;
      if (!result.namespace || !Array.isArray(result.value.tasks)) throw new Error('Runtime identity missing');
      if (this.namespace && this.namespace !== result.namespace) {
        clearTimeout(this.timer); this.generation++; this.task = null; this.uncertain = false;
        this.polling = false; this.cancelling = false; this.cancelRequested = false;
      }
      this.namespace = result.namespace; this.tasks = result.value.tasks.filter(valid).slice(0, 20);
      const active = this.task && this.tasks.find(task => same(task, this.task));
      if (active) { this.accept(active); if (throughputFinished(this.task)) clearTimeout(this.timer); }
    } catch {
      if (this.current(generation)) this.error = 'Unable to read throughput tasks. Retry checks status only.';
    } finally { if (this.live) { this.reading = false; this.changed(); } }
  }
  observe(task) {
    if (!this.live || this.reading || this.starting || this.cancelling || !this.namespace || !this.tasks.some(item => same(item, task))) return;
    clearTimeout(this.timer); this.generation++; this.polling = false; this.task = task;
    this.uncertain = false; this.cancelRequested = false; this.error = ''; this.changed(); void this.check();
  }
  async start(direction, policy) {
    if (!this.live || this.busy || this.reading || !this.namespace || !policy) return;
    clearTimeout(this.timer); const generation = ++this.generation, namespace = this.namespace;
    this.starting = true; this.task = null; this.cancelRequested = false; this.error = ''; this.changed();
    try {
      const result = await this.api.start({ direction, policy }, namespace);
      if (!this.current(generation)) return;
      if (result.namespace !== namespace || !valid(result.value)) throw new Error('Unconfirmed receipt');
      this.task = result.value; this.tasks = [result.value, ...this.tasks.filter(task => task.id !== result.value.id)].slice(0, 20);
      this.starting = false;
      if (this.cancelRequested && !throughputFinished(this.task)) await this.cancel(); else this.schedule();
    } catch (error) {
      if (!this.current(generation)) return;
      this.uncertain = ![400, 401, 403, 404, 412, 422].includes(error?.status);
      this.error = this.uncertain ? 'Start result is unconfirmed. Check recent tasks before starting again.' :
        'Unable to start throughput test. Check the policy, runtime and configured Testing URL.';
    } finally { if (this.current(generation)) { this.starting = false; this.changed(); } }
  }
  async check(attempt = 0) {
    if (!this.live || this.polling || this.starting || this.cancelling || !this.task || !this.namespace) return;
    clearTimeout(this.timer); this.polling = true;
    const generation = this.generation, original = this.task, version = ++this.readVersion;
    try {
      const result = await this.api.get(original.id, this.namespace);
      if (!this.current(generation) || version !== this.readVersion) return;
      if (result.namespace !== this.namespace || !valid(result.value) || !same(original, result.value)) throw new Error('Task identity changed');
      this.accept(result.value); this.error = ''; this.schedule();
    } catch {
      if (!this.current(generation) || version !== this.readVersion) return;
      if (attempt < 2) this.timer = setTimeout(() => void this.check(attempt + 1), 500);
      else this.error = 'Unable to observe throughput test. Check status to resume; no test is resubmitted.';
    } finally { if (this.current(generation) && version === this.readVersion) { this.polling = false; this.changed(); } }
  }
  async cancel() {
    if (!this.live || this.cancelling || !this.busy || this.uncertain) return;
    this.cancelRequested = true; this.changed(); if (this.starting || !this.task) return;
    clearTimeout(this.timer); const generation = this.generation, original = this.task;
    this.readVersion++; this.polling = false; this.cancelling = true; this.changed();
    try {
      const result = await this.api.cancel(original.id, this.namespace);
      if (!this.current(generation)) return;
      if (result.namespace !== this.namespace || !valid(result.value) || !same(original, result.value)) throw new Error('Task identity changed');
      this.accept(result.value); this.error = ''; this.schedule();
    } catch { if (this.current(generation)) this.error = 'Cancellation is unconfirmed. Check task status before retrying.'; }
    finally { if (this.current(generation)) { this.cancelling = false; this.changed(); } }
  }
  dismissUnconfirmed() {
    if (!this.live || !this.uncertain) return;
    this.uncertain = false; this.cancelRequested = false; this.error = ''; this.changed();
  }
  stopObserving() {
    if (!this.live || this.starting || this.cancelling || !this.task) return;
    clearTimeout(this.timer); this.generation++; this.polling = false; this.task = null;
    this.cancelRequested = false; this.error = ''; this.changed();
  }
}

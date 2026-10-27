export class PanelObservation {
  constructor(api, changed) {
    this.api = api; this.changed = changed;
    this.panels = []; this.pending = new Set(); this.errors = new Set();
    this.generation = 0; this.namespace = ''; this.revision = null;
    this.loading = false; this.loaded = false; this.error = false; this.active = true;
    this.timer = null; this.polls = 0;
  }

  retire() { this.active = false; this.generation++; clearTimeout(this.timer); this.timer = null; }

  // Core runs a panel script in the background; re-read the list until it settles.
  poll() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.active || this.polls >= 30 || !this.panels.some(panel => panel.refreshing)) return;
    this.timer = setTimeout(() => { this.timer = null; this.polls++; void this.load(false, true); }, 2000);
  }

  runtime(namespace) {
    if (!namespace || namespace === this.namespace) return;
    this.namespace = namespace;
    this.panels = []; this.loaded = false;
    void this.load(true);
  }

  async load(force = false, quiet = false) {
    if (!this.active || !force && (this.loading || this.pending.size)) return;
    const generation = ++this.generation;
    if (!quiet) { this.polls = 0; this.loading = true; this.pending.clear(); this.changed(); }
    this.error = false;
    let namespace = '';
    try {
      const result = await this.api.read(value => { namespace = value || ''; });
      if (!this.active || generation !== this.generation) return;
      if (!result.ok || !Array.isArray(result.panels)) throw new Error('Invalid panel snapshot');
      this.panels = result.panels; this.revision = result.revision;
      if (namespace) this.namespace = namespace;
      this.loaded = true; this.errors.clear();
    } catch {
      if (this.active && generation === this.generation) this.error = true;
    } finally {
      if (this.active && generation === this.generation) { this.loading = false; this.changed(); this.poll(); }
    }
  }

  async refresh(name) {
    const panel = this.panels.find(item => item.name === name);
    if (!this.active || this.loading || !this.namespace || !panel || panel.script_name == null || panel.refreshing || this.pending.has(name)) return;
    const generation = this.generation;
    this.pending.add(name); this.errors.delete(name); this.changed();
    let namespace = '';
    try {
      const result = await this.api.refresh(name, value => { namespace = value || ''; });
      if (!this.active || generation !== this.generation) return;
      if (result.revision !== this.revision || namespace && this.namespace && namespace !== this.namespace) {
        this.panels = []; this.loaded = false;
        await this.load(true); return;
      }
      if (!result.ok || result.panel?.error || result.panel?.name !== name) throw new Error('Panel refresh failed');
      this.panels = this.panels.map(item => item.name === name ? result.panel : item);
    } catch (error) {
      if (!this.active || generation !== this.generation) return;
      if (error?.status === 412) { this.panels = []; this.loaded = false; await this.load(true); }
      else this.errors.add(name);
    } finally {
      if (this.active && generation === this.generation) { this.pending.delete(name); this.changed(); this.poll(); }
    }
  }
}

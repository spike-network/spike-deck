/**
 * Keeps a copy of the connection list current from
 * `GET /spike/connections/changes` responses, so a refresh does not have to
 * re-read every record.
 */
export class ConnectionMirror {
  constructor() {
    this.reset();
  }

  reset() {
    this.cursor = '';
    this.revision = 0;
    this.live = new Map();
    this.recentById = new Map();
    this.recentIds = [];
  }

  /**
   * Applies one response. Returns true when a record was added, replaced or
   * removed; byte counters alone do not count, because the list renders none.
   */
  apply(changes) {
    let changed = false;
    if (changes.reset === true) {
      changed = this.live.size > 0 || this.recentIds.length > 0;
      this.live = new Map();
      this.recentById = new Map();
      this.recentIds = [];
    }
    for (const id of changes.removed_live_ids || []) changed = this.live.delete(id) || changed;
    for (const record of changes.live || []) {
      this.live.set(record.id, record);
      changed = true;
    }
    for (const stat of changes.live_stats || []) {
      const held = this.live.get(stat.id);
      if (!held) continue;
      held.upload_bytes = stat.upload_bytes;
      held.download_bytes = stat.download_bytes;
      held.duration_ms = stat.duration_ms;
      if (stat.modified !== undefined) held.modified = stat.modified;
    }
    const ids = changes.recent_ids || [];
    for (const record of changes.recent || []) {
      this.recentById.set(record.id, record);
      changed = true;
    }
    if (ids.length !== this.recentIds.length || ids.some((id, index) => id !== this.recentIds[index])) {
      changed = true;
    }
    const keep = new Set(ids);
    for (const id of this.recentById.keys()) if (!keep.has(id)) this.recentById.delete(id);
    this.recentIds = ids.slice();
    this.cursor = typeof changes.cursor === 'string' ? changes.cursor : '';
    this.revision = Number.isSafeInteger(changes.revision) ? changes.revision : this.revision;
    return changed;
  }

  snapshot() {
    return {
      sequence: this.revision,
      live: [...this.live.values()].sort((a, b) => a.id - b.id),
      recent: this.recentIds.map((id) => this.recentById.get(id)).filter(Boolean)
    };
  }
}

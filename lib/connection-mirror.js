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
    this.resetRequired = false;
  }

  /**
   * Applies one response. Returns true when a record was added, replaced or
   * removed; byte counters alone do not count, because the list renders none.
   * Returns null (and sets `resetRequired = true`) without advancing cursor or
   * revision when `live_stats` or `recent_ids` references an unknown record.
   */
  apply(changes) {
    const nextLive = changes.reset === true ? new Map() : new Map(this.live);
    let changed = changes.reset === true && (this.live.size > 0 || this.recentIds.length > 0);
    for (const id of changes.removed_live_ids || []) changed = nextLive.delete(id) || changed;
    for (const record of changes.live || []) {
      nextLive.set(record.id, record);
      changed = true;
    }
    const stats = changes.live_stats || [];
    for (const stat of stats) {
      if (!nextLive.has(stat.id)) {
        this.resetRequired = true;
        return null;
      }
    }
    const nextRecentById = changes.reset === true ? new Map() : new Map(this.recentById);
    for (const record of changes.recent || []) {
      nextRecentById.set(record.id, record);
      changed = true;
    }
    const ids = changes.recent_ids || [];
    for (const id of ids) {
      if (!nextRecentById.has(id)) {
        this.resetRequired = true;
        return null;
      }
    }
    for (const stat of stats) {
      const held = nextLive.get(stat.id);
      held.upload_bytes = stat.upload_bytes;
      held.download_bytes = stat.download_bytes;
      held.duration_ms = stat.duration_ms;
      if (stat.modified !== undefined) held.modified = stat.modified;
    }
    if (ids.length !== this.recentIds.length || ids.some((id, index) => id !== this.recentIds[index])) {
      changed = true;
    }
    const keep = new Set(ids);
    for (const id of nextRecentById.keys()) if (!keep.has(id)) nextRecentById.delete(id);
    this.live = nextLive;
    this.recentById = nextRecentById;
    this.recentIds = ids.slice();
    this.cursor = typeof changes.cursor === 'string' ? changes.cursor : '';
    this.revision = Number.isSafeInteger(changes.revision) ? changes.revision : this.revision;
    this.resetRequired = false;
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

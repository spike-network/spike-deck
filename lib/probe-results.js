import { isDirectGroupProbeResult } from "./group-selection.js";

export function probeResultKey(groupName, memberName) {
  return `${groupName}\0${memberName}`;
}

// Core-persisted member health is authoritative; task results only fill in
// members that Core has not reported yet.
export function ingestPersistedMemberInfo(store, groups) {
  const valid = new Set();
  const authoritative = new Set();
  (groups || []).forEach((g) => {
    (g.members || []).forEach((member) => valid.add(probeResultKey(g.name, member)));
    if (Array.isArray(g.member_info)) {
      g.member_info.forEach((info) => {
        if (info && info.name) {
          const key = probeResultKey(g.name, info.name);
          authoritative.add(key);
          store.set(key, {
            authoritative: true,
            sourceMember: info.name,
            ms: info.last_test_ms ?? null,
            ok: info.last_test_ok,
            err: info.last_test_ok === false ? "Timeout" : null,
            at: info.last_test_at_unix_ms || 0,
            udpOk: info.last_udp_test_ok,
            udpMs: info.last_udp_test_ms ?? null,
          });
        }
      });
    }
  });
  for (const key of store.keys()) {
    if (!valid.has(key) || (store.get(key)?.authoritative && !authoritative.has(key))) {
      store.delete(key);
    }
  }
}

export function recordProbeResults(store, groupName, results, fallbackAt = Date.now()) {
  (results || []).forEach((result) => {
    if (!isDirectGroupProbeResult(groupName, result)) return;
    const key = probeResultKey(groupName, result.member);
    const recordedAt = result.tested_at_unix_ms || fallbackAt;
    const existing = store.get(key);
    if (existing?.authoritative) return;
    if (existing && existing.at && recordedAt < existing.at) return;
    store.set(key, {
      sourceMember: result.member,
      ms: result.latency_ms ?? null,
      ok: result.ok === true,
      err: result.error || (result.ok ? null : "Timeout"),
      at: recordedAt,
      udpOk: result.udp_ok,
      udpMs: result.udp_latency_ms ?? null,
      udpErr: result.udp_error || null,
    });
  });
}

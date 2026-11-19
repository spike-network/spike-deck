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
          const previous = store.get(key);
          const at = info.last_test_at_unix_ms || 0;
          const sameProbe = at > 0 && previous?.at === at;
          authoritative.add(key);
          store.set(key, {
            authoritative: true,
            sourceMember: info.name,
            ms: info.last_test_ms ?? null,
            ok: info.last_test_ok,
            err: info.last_test_ok === false ? (sameProbe && previous.err) || "Timeout" : null,
            error_code: info.last_test_ok === false && sameProbe ? previous.error_code : undefined,
            at,
            udpOk: info.last_udp_test_ok,
            udpMs: info.last_udp_test_ms ?? null,
            udpErr: info.last_udp_test_ok === false && sameProbe ? previous.udpErr : undefined,
            udp_error_code: info.last_udp_test_ok === false && sameProbe ? previous.udp_error_code : undefined,
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
    if (existing?.authoritative) {
      if (result.tested_at_unix_ms && existing.at === result.tested_at_unix_ms) {
        if (existing.ok === false && result.ok === false) {
          existing.err = result.error || existing.err;
          existing.error_code = result.error_code;
        }
        if (existing.udpOk === false && result.udp_ok === false) {
          existing.udpErr = result.udp_error;
          existing.udp_error_code = result.udp_error_code;
        }
      }
      return;
    }
    if (existing && existing.at && recordedAt < existing.at) return;
    store.set(key, {
      sourceMember: result.member,
      ms: result.latency_ms ?? null,
      ok: result.ok === true,
      err: result.error || null,
      error_code: result.error_code,
      at: recordedAt,
      udpOk: result.udp_ok,
      udpMs: result.udp_latency_ms ?? null,
      udpErr: result.udp_error || null,
      udp_error_code: result.udp_error_code,
    });
  });
}

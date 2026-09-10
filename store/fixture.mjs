export const now = 1788800000000;

export function fixture(stress = false) {
  const names = [
    "Edge A",
    "Edge B",
    stress ? "Long-node-name-for-responsive-review.example.test" : "Backup C",
  ];
  const members = names.map((name, i) => ({
    name,
    type: ["shadowsocks", "trojan", "snell"][i],
    last_test_ok: true,
    last_test_ms: [24, 62, 128][i],
    last_test_at_unix_ms: now,
  }));
  const groups = ["Automatic", "Streaming", "Fallback"].map((name, i) => ({
    name,
    kind: ["smart", "select", "fallback"][i],
    selected: names[i],
    selection_basis: i === 1 ? "manual" : "auto",
    members: names,
    member_info: members,
  }));
  groups[0].selected = stress ? names[2] : names[0];
  groups[0].override_member = stress ? names[2] : names[0];
  groups[0].selection_basis = "manual_override";
  return {
    status: {
      revision: 7,
      profile: "example.conf",
      loaded_at_unix: now / 1000,
      groups: 3,
      leaves: 3,
      rules: 128,
      dns_servers: [],
      geoip_loaded: true,
      listeners: [{ kind: "mixed", address: "127.0.0.1:6152" }],
    },
    groups: { revision: 7, groups },
    outbound: { mode: "rule" },
    policies: { policies: members },
    "group-tests": { tasks: [] },
    "dns/delay": { delay: 12 },
    profiles: { profiles: ["example"] },
    "profiles/current": {
      profile: "[General]\n[Proxy Group]\n[Rule]\nFINAL,DIRECT\n",
    },
    providers: {
      providers: [
        {
          id: "rules",
          type: "rule-set",
          source_kind: "remote",
          source: "https://rules.example.test/default.list",
          status: "ready",
          last_updated_unix: now / 1000,
          update_interval_seconds: 3600,
        },
      ],
    },
    "metrics.json": {
      traffic: {
        download_bytes_per_second: stress ? 999000000 : 1234567,
        upload_bytes_per_second: stress ? 999000000 : 54321,
        download_bytes_total: stress ? 999000000000 : 164000000,
        upload_bytes_total: stress ? 999000000000 : 12000000,
      },
    },
  };
}

// Only the browser boundary is mocked; production page scripts render all UI.
export function installChromeMock({ theme, language, now }) {
  localStorage.setItem("spike.deck.theme", theme);
  Date.now = () => now;
  window.__screenshotErrors = [];
  const event = { addListener() {}, removeListener() {} };
  const data = {
    instances: [
      { id: "fixture", name: "Demo", baseUrl: location.origin, secret: "" },
    ],
    activeInstanceId: "fixture",
    enableProxyMode: true,
    uiLanguage: language,
    groupExpandMode: "collapse-all",
    healthCheckInterval: 300,
    trafficRefreshInterval: 60,
  };
  window.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === "string") keys = [keys];
          return structuredClone(
            keys ? Object.fromEntries(keys.map((k) => [k, data[k]])) : data,
          );
        },
        async set(values) {
          Object.assign(data, values);
        },
        async remove(key) {
          delete data[key];
        },
      },
      onChanged: event,
    },
    runtime: {
      getURL: (p) => new URL(p, location.origin).href,
      getManifest: () => ({ version: "0.0.0" }),
      onMessage: event,
      connect: () => ({
        postMessage() {},
        disconnect() {},
        onMessage: event,
        onDisconnect: event,
      }),
      async sendMessage({ type }) {
        if (type === "GET_GROUP_TEST_STATE") return { ok: true, tasks: [] };
        if (type === "GET_PROVIDER_REFRESH_TASK")
          return { ok: true, task: null };
        if (type === "GET_PROXY_SETTING_STATE")
          return {
            ok: true,
            controlledBySpikeDeck: true,
            levelOfControl: "controlled_by_this_extension",
          };
        if (type === "TRAFFIC_SAMPLE") return { ok: true };
        const message = `Unmocked runtime message: ${type}`;
        window.__screenshotErrors.push(message);
        throw new Error(message);
      },
    },
    i18n: { getUILanguage: () => language },
    permissions: { contains: async () => true },
    tabs: {
      async query(_query, callback) {
        const tabs = [{ id: 1, height: 800, url: "https://www.example.test/" }];
        callback?.(tabs);
        return tabs;
      },
    },
    commands: {
      getAll: async () => [
        { name: "_execute_action", shortcut: "Ctrl+Shift+K" },
      ],
    },
  };
}

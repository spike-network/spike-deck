// Import first: pins the UI language to zh-CN for tests that assert Chinese text.
globalThis.chrome = Object.assign(globalThis.chrome ?? {}, { i18n: { getUILanguage: () => "zh-CN" } });

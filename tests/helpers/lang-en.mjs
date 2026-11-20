// Import first: pins the UI language to English so output does not depend on the host locale.
globalThis.chrome = Object.assign(globalThis.chrome ?? {}, { i18n: { getUILanguage: () => "en" } });

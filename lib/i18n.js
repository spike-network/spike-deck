import EN_CATALOG from "./locales/en.js";
import ZH_CATALOG from "./locales/zh-CN.js";

export const UI_LANGUAGE_KEY = "uiLanguage";
export const SUPPORTED_UI_LANGUAGES = Object.freeze(["zh-CN", "en"]);

// Explicit message catalogs (lib/locales): the single source of UI text.
// Script text uses `msg(key)`; static HTML uses `data-i18n` attributes, applied
// once at load and again when the language changes.
export const MESSAGE_CATALOGS = Object.freeze({ en: EN_CATALOG, "zh-CN": ZH_CATALOG });
const FALLBACK_LANGUAGE = "en";
// data-i18n-<name> attribute -> translated element attribute.
const MESSAGE_ATTRIBUTES = Object.freeze({
  "data-i18n-title": "title",
  "data-i18n-placeholder": "placeholder",
  "data-i18n-aria-label": "aria-label",
});
const MESSAGE_SELECTOR = ["[data-i18n]", ...Object.keys(MESSAGE_ATTRIBUTES).map((name) => `[${name}]`)].join(",");

let currentLanguage = null;
let initializationPromise = null;
let storageListenerInstalled = false;
const languageListeners = new Set();

export function resolvePreferredLanguage(language) {
  return String(language || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function browserPreferredLanguage() {
  const uiLanguage = globalThis.chrome?.i18n?.getUILanguage?.();
  return resolvePreferredLanguage(uiLanguage || globalThis.navigator?.languages?.[0] || globalThis.navigator?.language);
}

function validLanguage(language) {
  return SUPPORTED_UI_LANGUAGES.includes(language);
}

export function formatMessage(key, params, language) {
  const template = MESSAGE_CATALOGS[language]?.[key] ?? MESSAGE_CATALOGS[FALLBACK_LANGUAGE][key];
  // A missing key shows the key itself so the gap is visible, not blank.
  if (template == null) return key;
  return template.replace(/\{(\w+)\}/g, (placeholder, name) =>
    params && Object.hasOwn(params, name) ? String(params[name]) : placeholder);
}

export function msg(key, params) {
  return formatMessage(key, params, currentLanguage || browserPreferredLanguage());
}

function messageParams(element) {
  const raw = element.getAttribute("data-i18n-params");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function applyElementMessages(element) {
  const params = messageParams(element);
  const key = element.getAttribute("data-i18n");
  if (key) {
    const text = msg(key, params);
    if (element.textContent !== text) element.textContent = text;
  }
  for (const [source, attribute] of Object.entries(MESSAGE_ATTRIBUTES)) {
    const attributeKey = element.getAttribute(source);
    if (attributeKey) element.setAttribute(attribute, msg(attributeKey, params));
  }
}

/** Renders every data-i18n element under `root` in the current language. */
export function applyMessages(root = globalThis.document) {
  if (!root?.querySelectorAll) return;
  if (root.matches?.(MESSAGE_SELECTOR)) applyElementMessages(root);
  for (const element of root.querySelectorAll(MESSAGE_SELECTOR)) applyElementMessages(element);
}

/**
 * Sets an element's text from a message key and records the key, so a later
 * language change re-renders it without a document observer.
 */
export function setMessage(element, key, params) {
  element.setAttribute("data-i18n", key);
  if (params && Object.keys(params).length) element.setAttribute("data-i18n-params", JSON.stringify(params));
  else element.removeAttribute("data-i18n-params");
  element.textContent = msg(key, params);
}

/** Sets text that is not a message (names, Core errors) and drops any key. */
export function setPlainText(element, text) {
  element.removeAttribute("data-i18n");
  element.removeAttribute("data-i18n-params");
  element.textContent = text;
}

export function translateDocument(root = globalThis.document?.documentElement) {
  if (!root || !globalThis.document) return;
  applyMessages(root);
  document.documentElement.lang = currentLanguage;
}

/**
 * Registers a callback for a runtime language switch (made on any page).
 * Pages whose text is built in script rather than in static HTML re-render,
 * or reload, from it; static data-i18n text is already refreshed by then.
 */
export function onLanguageChange(listener) {
  languageListeners.add(listener);
  return () => languageListeners.delete(listener);
}

function notifyLanguageChange() {
  for (const listener of languageListeners) listener(currentLanguage);
}

function installStorageListener() {
  if (storageListenerInstalled || !globalThis.chrome?.storage?.onChanged) return;
  storageListenerInstalled = true;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    const language = changes[UI_LANGUAGE_KEY]?.newValue;
    if (areaName !== "local" || !validLanguage(language)) return;
    if (language === currentLanguage) return;
    currentLanguage = language;
    translateDocument();
    notifyLanguageChange();
  });
}

/** Resolves the UI language and renders the page's data-i18n text once. */
export async function initializeI18n() {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      let language = null;
      try {
        const data = await chrome.storage.local.get([UI_LANGUAGE_KEY]);
        language = data[UI_LANGUAGE_KEY];
        if (!validLanguage(language)) {
          language = browserPreferredLanguage();
          await chrome.storage.local.set({ [UI_LANGUAGE_KEY]: language });
        }
      } catch {
        language = browserPreferredLanguage();
      }
      currentLanguage = language;
      installStorageListener();
      translateDocument();
      globalThis.document?.documentElement?.classList.remove("i18n-pending");
      return language;
    })();
  }
  return initializationPromise;
}

export function getCurrentLanguage() {
  return currentLanguage || browserPreferredLanguage();
}

export async function setCurrentLanguage(language) {
  if (!validLanguage(language)) throw new Error(`Unsupported UI language: ${language}`);
  currentLanguage = language;
  await chrome.storage.local.set({ [UI_LANGUAGE_KEY]: language });
  translateDocument();
  notifyLanguageChange();
  return language;
}

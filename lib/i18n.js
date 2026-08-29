import {
  EN_MESSAGES,
  EN_PATTERNS,
  ZH_MESSAGES,
  ZH_PATTERNS,
} from "./i18n-messages.js";

export const UI_LANGUAGE_KEY = "uiLanguage";
export const SUPPORTED_UI_LANGUAGES = Object.freeze(["zh-CN", "en"]);

const TRANSLATABLE_ATTRIBUTES = ["title", "placeholder", "aria-label"];
const USER_CONTENT_SELECTOR = [
  "pre",
  "code",
  "script",
  "style",
  "textarea",
  "[data-i18n-ignore]",
  ".group-name",
  ".member-name",
  ".current-selected",
  "#quick-instance-value",
  "#quick-profile-value",
  "#instance-select option:not([value=''])",
  "#profile-select option:not([value=''])",
  "#outbound-policy-select option:not([value=''])",
  ".provider-source",
  ".provider-origin",
  ".info-value",
  ".instance-name",
].join(",");

const textSources = new WeakMap();
const attributeSources = new WeakMap();
let currentLanguage = null;
let initializationPromise = null;
let observer = null;
let storageListenerInstalled = false;

function normalizeMessage(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

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

function applyPatterns(value, patterns) {
  for (const [pattern, replacement] of patterns) {
    if (pattern.test(value)) return value.replace(pattern, replacement);
  }
  return value;
}

export function translateForLanguage(message, language) {
  const source = normalizeMessage(message);
  if (!source) return source;
  if (language === "en") {
    const exact = EN_MESSAGES[source];
    return exact ?? applyPatterns(source, EN_PATTERNS);
  }
  const exact = ZH_MESSAGES[source];
  return exact ?? applyPatterns(source, ZH_PATTERNS);
}

export function t(message) {
  return translateForLanguage(message, currentLanguage || browserPreferredLanguage());
}

export function messageMatches(value, source) {
  const normalized = normalizeMessage(value);
  return SUPPORTED_UI_LANGUAGES.some(
    (language) => normalized === translateForLanguage(source, language),
  );
}

function isKnownTranslation(value, source) {
  const normalized = normalizeMessage(value);
  return SUPPORTED_UI_LANGUAGES.some(
    (language) => normalized === translateForLanguage(source, language),
  );
}

function shouldSkipTextNode(node) {
  const parent = node.parentElement;
  return !parent || Boolean(parent.closest(USER_CONTENT_SELECTOR));
}

function translateTextNode(node) {
  if (shouldSkipTextNode(node)) return;
  const current = node.nodeValue || "";
  const previousSource = textSources.get(node);
  const source = previousSource != null && isKnownTranslation(current, previousSource)
    ? previousSource
    : current;
  textSources.set(node, source);
  const translated = translateForLanguage(source, currentLanguage);
  if (translated === normalizeMessage(source)) {
    if (current !== source) node.nodeValue = source;
    return;
  }
  const leading = source.match(/^\s*/)?.[0] || "";
  const trailing = source.match(/\s*$/)?.[0] || "";
  const target = `${leading}${translated}${trailing}`;
  if (current !== target) node.nodeValue = target;
}

function sourceMapForElement(element) {
  let sources = attributeSources.get(element);
  if (!sources) {
    sources = new Map();
    attributeSources.set(element, sources);
  }
  return sources;
}

function translateAttribute(element, attribute) {
  if (!element.hasAttribute(attribute) || element.closest("[data-i18n-ignore]")) return;
  if (attribute === "title" && element.closest(USER_CONTENT_SELECTOR)) return;
  const current = element.getAttribute(attribute) || "";
  const sources = sourceMapForElement(element);
  const previousSource = sources.get(attribute);
  const source = previousSource != null && isKnownTranslation(current, previousSource)
    ? previousSource
    : current;
  sources.set(attribute, source);
  const translated = translateForLanguage(source, currentLanguage);
  if (current !== translated) element.setAttribute(attribute, translated);
}

function translateElement(element) {
  for (const attribute of TRANSLATABLE_ATTRIBUTES) {
    translateAttribute(element, attribute);
  }
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    translateTextNode(node);
    node = walker.nextNode();
  }
  for (const descendant of element.querySelectorAll("*")) {
    for (const attribute of TRANSLATABLE_ATTRIBUTES) {
      translateAttribute(descendant, attribute);
    }
  }
}

export function translateDocument(root = globalThis.document?.documentElement) {
  if (!root || !globalThis.document) return;
  translateElement(root);
  document.documentElement.lang = currentLanguage;
}

function installObserver() {
  if (observer || !globalThis.document) return;
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") {
        translateTextNode(record.target);
        continue;
      }
      if (record.type === "attributes") {
        translateAttribute(record.target, record.attributeName);
        continue;
      }
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
        else if (node instanceof Element) translateElement(node);
      }
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANSLATABLE_ATTRIBUTES,
  });
}

function installStorageListener() {
  if (storageListenerInstalled || !globalThis.chrome?.storage?.onChanged) return;
  storageListenerInstalled = true;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    const language = changes[UI_LANGUAGE_KEY]?.newValue;
    if (areaName !== "local" || !validLanguage(language)) return;
    currentLanguage = language;
    translateDocument();
  });
}

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
      installObserver();
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
  return language;
}

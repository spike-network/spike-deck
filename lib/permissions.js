/**
 * Host permissions helper for SpikeDeck.
 * Supports dynamic requesting of optional_host_permissions for non-local Spike instances.
 */

/**
 * Returns a valid Chrome match pattern for a given URL's origin.
 * Match patterns do not include port numbers, paths, or query/hash.
 * Examples:
 *   - 'http://127.0.0.1:9090' -> 'http://127.0.0.1/*'
 *   - 'http://localhost:9090/' -> 'http://localhost/*'
 *   - 'http://192.168.1.100:9090' -> 'http://192.168.1.100/*'
 *   - 'https://spike.example.com/api' -> 'https://spike.example.com/*'
 *   - 'http://[::1]:9090' -> 'http://[::1]/*'
 *
 * @param {string|URL} url
 * @returns {string|null}
 */
export function originPatternFromUrl(url) {
 if (!url) return null;
 const raw = String(url).trim();
 if (!raw) return null;

 try {
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
   return null;
  }
  return `${parsed.protocol}//${parsed.hostname}/*`;
 } catch {
  return null;
 }
}

/**
 * Checks if a URL points to a standard local origin (which is pre-granted in manifest host_permissions).
 * @param {string|URL} url
 * @returns {boolean}
 */
export function isLocalOrigin(url) {
 if (!url) return false;
 try {
  const parsed = new URL(String(url).trim());
  const host = parsed.hostname.toLowerCase();
  return (
   host === "localhost" ||
   host === "127.0.0.1" ||
   host === "[::1]" ||
   host === "::1"
  );
 } catch {
  return false;
 }
}

/**
 * Checks whether the extension currently has permission to access the given URL.
 * @param {string|URL} url
 * @returns {Promise<boolean>}
 */
export async function hasHostPermission(url) {
 if (isLocalOrigin(url)) {
  return true;
 }
 const pattern = originPatternFromUrl(url);
 if (!pattern) {
  return false;
 }
 if (typeof chrome === "undefined" || !chrome.permissions?.contains) {
  return true;
 }
 try {
  return await chrome.permissions.contains({ origins: [pattern] });
 } catch {
  return false;
 }
}

/**
 * Requests permission from the user to access the given URL.
 * Must be invoked inside a user gesture (e.g. click, submit).
 * @param {string|URL} url
 * @returns {Promise<boolean>}
 */
export async function requestHostPermission(url) {
 if (isLocalOrigin(url)) {
  return true;
 }
 const pattern = originPatternFromUrl(url);
 if (!pattern) {
  return false;
 }
 if (typeof chrome === "undefined" || !chrome.permissions?.request) {
  return true;
 }
 try {
  return await chrome.permissions.request({ origins: [pattern] });
 } catch {
  return false;
 }
}

/**
 * Ensures host permission is granted for the given URL, prompting the user if necessary.
 * @param {string|URL} url
 * @returns {Promise<boolean>}
 */
export async function ensureHostPermission(url) {
 const has = await hasHostPermission(url);
 if (has) return true;
 return await requestHostPermission(url);
}

/**
 * Size the action popup from the browser's visible area.
 *
 * The popup document cannot use `100vh` / `window.innerHeight` of the tab;
 * those refer to the popup itself. `chrome.tabs.Tab.height` is the closest
 * viewport we can read without injecting a content script. Fall back to the
 * screen work area when the tab size is unavailable.
 */
(() => {
  const RATIO = 0.85;
  const MIN_PX = 280;
  const MAX_PX = 600;
  const REVEAL_TIMEOUT_MS = 100;
  const root = document.documentElement;
  let revealTimer = null;

  root.classList.add('popup-sizing');

  function apply(viewportHeight) {
    const px = Math.min(
      MAX_PX,
      Math.max(MIN_PX, Math.round(Number(viewportHeight) * RATIO)),
    );
    if (!Number.isFinite(px)) return;
    document.documentElement.style.setProperty('--popup-max-height', `${px}px`);
  }

  function reveal() {
    if (revealTimer !== null) clearTimeout(revealTimer);
    revealTimer = null;
    root.classList.remove('popup-sizing');
  }

  apply(window.screen?.availHeight || 800);
  revealTimer = setTimeout(reveal, REVEAL_TIMEOUT_MS);

  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const height = tabs && tabs[0] && tabs[0].height;
      if (height > 0) apply(height);
      requestAnimationFrame(reveal);
    });
  } catch {
    requestAnimationFrame(reveal);
  }
})();

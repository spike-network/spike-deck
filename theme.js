(() => {
  const key = "spike.deck.theme";
  const valid = (value) =>
    value === "light" || value === "dark" ? value : "system";
  function read() {
    try {
      return valid(localStorage.getItem(key));
    } catch {
      return "system";
    }
  }
  let theme = read();
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  function apply() {
    document.documentElement.dataset.spikeTheme =
      theme === "system" ? (media.matches ? "dark" : "light") : theme;
    document
      .querySelectorAll("[data-spike-theme-control]")
      .forEach((control) => {
        control.value = theme;
      });
  }
  apply();
  media.addEventListener("change", apply);
  window.addEventListener("storage", (event) => {
    if (event.key !== key && event.key !== null) return;
    theme = read();
    apply();
  });
  document.addEventListener("DOMContentLoaded", () => {
    apply();
    document
      .querySelectorAll("[data-spike-theme-control]")
      .forEach((control) => {
        control.addEventListener("change", () => {
          theme = valid(control.value);
          try {
            localStorage.setItem(key, theme);
          } catch {
            /* Session-only preference. */
          }
          apply();
        });
      });
  });
})();

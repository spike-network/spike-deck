export function initializeOptionsTabs(document, window) {
  const names = ["global", "instances"];
  const tabs = names.map((name) => document.getElementById(`tab-${name}`));
  const panels = names.map((name) => document.getElementById(`options-${name}`));
  function select(name, focus = false) {
    const selected = names.includes(name) ? name : "global";
    names.forEach((value, index) => {
      const active = value === selected;
      tabs[index].setAttribute("aria-selected", String(active));
      tabs[index].tabIndex = active ? 0 : -1;
      panels[index].hidden = !active;
      if (active && focus) tabs[index].focus();
    });
    return selected;
  }
  tabs.forEach((tab, index) => {
    const activate = (next, focus = false) => {
      const name = select(names[next], focus);
      window.history.replaceState(null, "", `#${name}`);
    };
    tab.addEventListener("click", () => activate(index));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % names.length;
      else if (event.key === "ArrowLeft") next = (index + names.length - 1) % names.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = names.length - 1;
      else return;
      event.preventDefault();
      activate(next, true);
    });
  });
  const sync = () => select(window.location.hash.slice(1));
  window.addEventListener("hashchange", sync);
  sync();
}

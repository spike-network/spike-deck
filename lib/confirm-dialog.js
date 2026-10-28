import { t } from "./i18n.js";

let sequence = 0;

export function confirmAction(title, description, document = globalThis.document) {
  const trigger = document.activeElement;
  const dialog = document.createElement("dialog");
  const id = `confirm-${++sequence}`;
  dialog.className = "confirm-dialog";
  dialog.setAttribute("role", "alertdialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", `${id}-title`);
  dialog.setAttribute("aria-describedby", `${id}-description`);
  const heading = document.createElement("h2");
  heading.id = `${id}-title`;
  heading.textContent = t(title);
  const body = document.createElement("p");
  body.id = `${id}-description`;
  body.textContent = t(description);
  const actions = document.createElement("div");
  actions.className = "confirm-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = t("取消");
  cancel.autofocus = true;
  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "danger";
  accept.textContent = t(title);
  actions.append(cancel, accept);
  dialog.append(heading, body, actions);
  document.body.append(dialog);
  return new Promise((resolve) => {
    let accepted = false;
    cancel.addEventListener("click", () => dialog.close());
    accept.addEventListener("click", () => {
      accepted = true;
      dialog.close();
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Enter") event.preventDefault();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      resolve(accepted);
    }, { once: true });
    dialog.showModal();
    cancel.focus({ preventScroll: true });
  });
}

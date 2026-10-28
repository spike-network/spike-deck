import assert from "node:assert/strict";
import test from "node:test";
import { confirmAction } from "../lib/confirm-dialog.js";

function fixture() {
  const document = {};
  class Node extends EventTarget {
    children = [];
    attributes = {};
    isConnected = true;
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(key, value) { this.attributes[key] = value; }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatchEvent(new Event("close")); }
    remove() { this.isConnected = false; }
    click() { this.dispatchEvent(new Event("click")); }
  }
  document.createElement = () => new Node();
  document.body = new Node();
  const trigger = new Node();
  trigger.focus();
  return { document, trigger };
}

for (const action of ["cancel", "escape", "accept"]) {
  test(`confirmation: ${action}, initial focus and focus restoration`, async () => {
    const { document, trigger } = fixture();
    const result = confirmAction("Terminate connection", "Mock description", document);
    const dialog = document.body.children.at(-1);
    const [heading, description, actions] = dialog.children;
    const [cancel, accept] = actions.children;
    assert.equal(dialog.attributes.role, "alertdialog");
    assert.equal(dialog.attributes["aria-labelledby"], heading.id);
    assert.equal(dialog.attributes["aria-describedby"], description.id);
    assert.equal(description.textContent, "Mock description");
    assert.equal(document.activeElement, cancel);
    assert.equal(dialog.open, true);
    assert.equal(accept.type, "button");
    assert.match(accept.className, /danger/);
    if (action === "escape") {
      // Native dialog's default Escape action emits cancel then closes.
      dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
      dialog.close();
    } else (action === "accept" ? accept : cancel).click();
    assert.equal(await result, action === "accept");
    assert.equal(dialog.isConnected, false);
    assert.equal(document.activeElement, trigger);
  });
}


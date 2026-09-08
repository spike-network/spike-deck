import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../popup.css", import.meta.url), "utf8");
const interaction = readFileSync(new URL("../interaction.css", import.meta.url), "utf8");
const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8");
// Popup autosizing can start below a media breakpoint. Only popup.css owns
// the root dimensions; responsive layers must not lock it to that initial size.
for (const layer of [interaction, theme]) {
  for (const [, selector, declarations] of layer.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selector.trim().split(',').some((part) => /^(?:html|body)(?:[.#:]\S*)?$/.test(part.trim())))
      assert.doesNotMatch(declarations, /(?:^|;)\s*(?:min-|max-)?width\s*:/);
  }
}
const sizing = readFileSync(
  new URL("../popup-max-height.js", import.meta.url),
  "utf8",
);

assert.match(css, /body\s*\{[\s\S]*?height:\s*var\(--popup-max-height, 600px\);/);
assert.match(css, /html\s*\{[\s\S]*?width:\s*415px;[\s\S]*?max-width:\s*415px;/);
assert.match(css, /body\s*\{[\s\S]*?width:\s*415px;[\s\S]*?max-width:\s*415px;/);
assert.match(css, /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\) minmax\(0, 1\.4fr\);/);
assert.match(css, /\.provider-row\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/);
const bodyRule = css.match(/body\s*\{([^}]+)\}/)[1];
const containerRule = css.match(/\.container\s*\{([^}]+)\}/)[1];
assert.match(bodyRule, /overflow:\s*hidden;/);
assert.doesNotMatch(bodyRule, /overflow-y:|scrollbar-gutter:/);
assert.match(containerRule, /height:\s*100%;/);
assert.match(containerRule, /contain:\s*size;/);
assert.match(containerRule, /overflow-y:\s*scroll;/);
for (const selector of ['html', 'body']) {
  const rule = css.match(new RegExp(`${selector}\\s*\\{([^}]+)\\}`))[1];
  assert.match(rule, /min-width:\s*415px;/);
}
assert.match(css, /scrollbar-gutter:\s*stable;/);
assert.match(css, /html\s*\{[\s\S]*?overflow:\s*hidden;/);
assert.match(css, /html\.popup-sizing\s*\{[\s\S]*?visibility:\s*hidden;/);
assert.match(sizing, /const MAX_PX = 600;/);
assert.match(sizing, /requestAnimationFrame\(reveal\);/);

console.log("popup layout tests passed");

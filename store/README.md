# Screenshots

Run from the repository root with Node.js 26:

```sh
make screenshots-setup
make screenshots
make screenshots-check
```

Setup installs locked development dependencies and their matching Chromium.
Linux hosts may also need Playwright's system dependencies (`cd store && npx playwright install-deps chromium`).
No running Core, extension installation, user browser profile, or real credentials are needed.

## Outputs

- `dist/screenshots/`: twelve 1280x800 24-bit RGB store images (no alpha), six scenes in light and dark themes, Chinese text.
- `dist/ui-check/`: thirty-two native viewport images, light/dark and Chinese/English; popup at 415x600, options at 320/1200px wide.
- Each directory includes `report.json` with the browser version and measured layout.

Scenes cover groups, outbound mode, Profile, providers, global options, and instance management.
Options images show the first viewport, not the entire scrollable settings page.
Store images center the unscaled real viewport on an outer canvas; no product CSS is overridden.
All generated files are ignored and excluded from the extension package.

`make screenshots-check` uses long member names and large traffic values. It asserts readiness,
image decoding, theme, horizontal page overflow, popup dimensions, toolbar wrapping, traffic
clipping, and nonblank pixels. This is a layout smoke test, not baseline pixel comparison or
installed-extension/background-worker end-to-end coverage.
English fixtures also reject visible untranslated Chinese UI text, excluding raw content and the language selector.

## Group health regression

Run `npm --prefix store run check:group-health` from the repository root after setup.
It mounts the production popup with synthetic API and Chrome boundaries, checking
that current member metadata supersedes historical task results, failed queries
retain last-good health and retry, progress reads coalesce, and late reads cannot
undo a selection refresh. No running Core or user browser profile is used.
`DECK_BASELINE_REF` can select a commit's `popup.js` as a negative control while
keeping the same fixture and assertions.

## Isolation And Failures

`npm --prefix store run check:dashboard-lifetime` covers 11 dashboard loading and
16 group mutation scenarios in isolated Chromium contexts. Deferred API replies
exercise instance switches, A-to-B-to-A transitions, old success/error/finally
callbacks and selection-refresh failures. It also checks same-instance success
and failure, busy state across redraws, click-to-collapse and Alt-click behavior.
`DECK_BASELINE_REF` runs the same assertions against an earlier popup implementation.

`capture.mjs` loads production HTML/CSS/JS through a request interceptor. `fixture.mjs` supplies
fixed synthetic API responses and Chrome APIs. Unknown requests/messages fail; requests never
reach the network. The only mocked POST is the startup DNS delay query. Production scripts
still render the page and handle scene navigation.

The command uses a fresh browser context per scene. A failed batch leaves the previous output
untouched. Output is staged beside the destination and replaced only after every scene passes;
a lock rejects concurrent runs targeting the same directory. Normal errors clean temporary files.
After a forced process kill, inspect and remove only that run's `.lock` and `.tmp-*` paths before retrying.

Optional environment variables:

- `CHROME_PATH`: use a specific Chromium executable instead of the pinned download.
- `SCREENSHOT_OUTPUT`: dedicate a directory to this command; successful runs replace its contents.

For reproducible comparisons, keep the lockfile, Chromium version, OS, and installed fonts identical.
Update the fixture when the API contract changes, not by copying production DOM into test HTML.

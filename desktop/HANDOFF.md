### Changed Files

Delta on top of `9e46d2c`, on `feat/desktop-d1`; no prior commit is amended.

- `desktop/src/bun/index.ts` — Add the standard App/Edit/Window role menus and the guarded system-browser openExternal request.
- `desktop/src/shared/rpc.ts` — Type the narrow openExternal URL request and boolean response.
- `desktop/src/shared/externalUrl.ts` — Share strict absolute HTTP/HTTPS URL validation between renderer and main process.
- `desktop/src/shared/externalUrl.test.ts` — Cover allowed HTTP/HTTPS and rejected JavaScript/file/data/custom/relative/malformed URLs.
- `desktop/src/shared/Markdown.tsx` — Map marked GFM lexer tokens to React elements and escaped text; intercept link navigation.
- `desktop/src/shared/markdown.test.tsx` — Cover code, incomplete fences, inline formatting, nested lists, tables, inert HTML/links, and click delegation.
- `desktop/src/mainview/App.tsx` — Render accumulated assistant text through Markdown and route external links over typed RPC.
- `desktop/src/mainview/index.css` — Scope readable markdown typography, code panels/language labels, tables and horizontal scrolling.
- `desktop/src/shared/transcript.ts` — Pluralize learned/recalled rules and compaction tokens correctly.
- `desktop/src/shared/transcript.test.ts` — Test singular/plural learning and compaction notices.
- `desktop/package.json` — Declare only marked at exact version 18.0.14 as the new dependency.
- `desktop/hutch.lock` — Lock the declared marked dependency installed by Hutch.
- `desktop/HANDOFF.md` — Record this delta, verification, native acceptance evidence and remaining limitations.

### Validation

- Devkit sources inspected: `ApplicationMenu.ts`, `menuRoles.ts`, `proc/native.ts` (`ApplicationMenuItemConfig`), and `Utils.ts` (`openExternal(url): boolean`). Menus use the verified role names and `{ type: "separator" }` shape.
- Native macOS composer acceptance: entered `clipboard-check`; ⌘A/⌘C, Right, ⌘V produced `clipboard-checkclipboard-check`; ⌘A/⌘X emptied the input; ⌘Z restored the exact text. No prompt was submitted to a provider.
- `npx tsc --noEmit` — exit 0, no diagnostics.
- `bun run lint` — exit 0: `Checked 400 files ... No fixes applied.`
- `bun run build` — exit 0: root CLI bundle succeeded.
- `timeout 600 bun test > /tmp/d1-md-final-bun-test.log 2>&1` — exit 0:

```text
 1257 pass
 0 fail
 18291 expect() calls
Ran 1257 tests across 210 files. [120.23s]
```
- `CI=true timeout 600 bun test > /tmp/d1-md-ci-bun-test.log 2>&1` — exit 0:

```text
 1257 pass
 0 fail
 18055 expect() calls
Ran 1257 tests across 210 files. [111.38s]
```
- An earlier full run hit the unchanged two-second TUI history wait in `daily-driver-input.test.tsx`. Its isolated recheck passed (`4 pass, 0 fail`), followed by passing full normal/CI runs; that file and TUI code were not changed.
- Focused markdown/URL/reducer tests — `16 pass, 0 fail, 91 expect() calls` across 3 files.
- In `desktop/`, Hutch commands used `PATH="$HOME/.hutch/bin:$PATH" DASH_RELEASE_OFFLINE=1`:
  - `hutch install` — installed `marked@18.0.14` and saved `hutch.lock`; no root-package fallback was needed.
  - `hutch install --frozen-lockfile` — exit 0, 77 installs checked across 128 packages without changes.
  - `hutch pm exec -- tsc --noEmit` — exit 0, no diagnostics.
  - `hutch pm exec -- vite build && hutch electrobun build --env=dev` — exit 0:

```text
../../dist/assets/noe-compact-Ukfhr7Cw.svg    6.16 kB │ gzip:  0.58 kB
../../dist/assets/noe-f11-BHSwU1Qc.svg       16.48 kB │ gzip:  1.20 kB
../../dist/assets/index-Y6gcXt_z.css          7.31 kB │ gzip:  2.15 kB
../../dist/assets/index-DxlX16If.js         210.28 kB │ gzip: 67.01 kB
✓ built in 762ms
hutch electrobun: macOS icon source not found: /Users/kwang/projects/octonoesis-wt/desktop-d1/desktop/icon.iconset
electrobun build complete: /Users/kwang/projects/octonoesis-wt/desktop-d1/desktop/build/dev-macos-arm64
```

- Playwright skill QA used the actual React/CSS with a temporary local RPC adapter. At 800px: unfinished fence remained a code panel; code content scrolled horizontally (1397px content in a 578px panel); nested lists/table/blockquote rendered; raw HTML created no image/script elements; an HTTP link was delegated to openExternal without changing the webview URL. The adapter/configuration were removed; shipped assets contain no adapter.
- QA artifacts: `/tmp/d1-md-visual.log`, `/tmp/d1-md-readable-800.png`; native launch log: `/tmp/d1-md-native.log`.
- `git diff --check` — clean. Root dependencies, engine/TUI code, unrelated tests and forbidden directories are unchanged.

### Success Conditions

- [x] Composer copy/paste/select-all/cut/undo acceptance verified in the native macOS application; standard App/Edit/Window menus use devkit roles.
- [x] Assistant markdown readability verified through pure mapping tests and a visual streaming preview. Code fences, inline code, formatting, lists, blockquotes, tables, hr and HTTP links render as elements; HTML stays literal and unsafe links inert.
- [x] openExternal validates URLs in the main process before calling Utils.openExternal; only HTTP/HTTPS are accepted. Validation unit tests and intercepted primary/middle-click tests pass.
- [x] Learning and compaction grammar tests pass for singular and plural counts.
- [x] All named root and desktop checks pass; final command outputs are recorded above.
- [x] New conventional commit on `feat/desktop-d1`: `fix(desktop): restore edit shortcuts and render safe markdown`, including this handoff. Parent `9e46d2c` remains unchanged.

### Risks & Deviations

- No scope deviations. Markdown is intentionally pulled forward into D1 by this contract; there is no HTML injection API, syntax highlighter, or additional dependency beyond marked@18.0.14.
- Markdown images remain literal text so assistant output does not load remote resources. Relative/non-HTTP links are inert.
- Native clipboard acceptance was verified directly. Markdown layout and link interception used a local RPC adapter; actual system-browser launch was not invoked during QA to avoid external navigation. The privileged handler uses the verified Electrobun Utils API and the tested URL validator.
- Existing D1 limitations remain: the development build depends on an engine checkout (standalone packaging is D4), and the absent icon.iconset produces a nonfatal build warning.

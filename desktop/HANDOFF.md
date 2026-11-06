### Changed Files

Delta on top of `dad849b`, on `feat/desktop-d1`. The original D1 implementation remains in that parent commit.

- `src/permissions/confirm.ts` — Export a mode-only setter reused by the existing CLI configurator; preserve permission decision logic and pending prompts.
- `src/host/protocol.ts` — Add validated set_permission_mode commands and permission_mode messages using the existing PermissionMode type.
- `src/host/main.ts` — Start in Ask, acknowledge mode changes immediately after ready and on switches, and correct successful Edit summaries in the host.
- `src/host/editSummary.ts` — Count added/removed lines with the existing root diffLines dependency, excluding unchanged context.
- `desktop/src/shared/transcript.ts` — Track permission mode without resolving pending permissions; retain successful Edit summaries on tool cards.
- `desktop/src/shared/transcript.test.ts` — Test mode updates/reset, pending-request preservation, actual line counts, and Edit summary retention.
- `desktop/src/mainview/App.tsx` — Add the three-mode title-bar menu and in-app Bypass confirmation; resize composer input and display corrected Edit summaries.
- `desktop/src/mainview/index.css` — Separate input/action rows, cap input growth at about eight lines, and style the mode menu and amber Bypass pill.
- `test/fixtures/host/preload.ts` — Script real Read/Edit/Bash calls through the existing provider-injection fixture.
- `test/integration/host-protocol.test.ts` — Validate mode handshake, Bypass/Accept edits, invalid modes, pending prompts, deny-pattern precedence, and Edit summary output.
- `desktop/HANDOFF.md` — Record this Delta Contract, current validation, acceptance evidence, and limitations.

### Validation

- `npx tsc --noEmit` — exit 0, no diagnostics.
- `bun run lint` — exit 0: `Checked 396 files ... No fixes applied.`
- `bun run build` — exit 0: `Bundled 822 modules ... cli.js 4.17 MB`.
- `timeout 600 bun test > /tmp/d1-delta-final-bun-test.log 2>&1` — exit 0:

```text
 1248 pass
 0 fail
 18230 expect() calls
Ran 1248 tests across 208 files. [119.86s]
```

- `CI=true timeout 600 bun test > /tmp/d1-delta-ci-bun-test.log 2>&1` — exit 0:

```text
 1248 pass
 0 fail
 17999 expect() calls
Ran 1248 tests across 208 files. [141.46s]
```
- In `desktop/`, all Hutch commands used `PATH="$HOME/.hutch/bin:$PATH" DASH_RELEASE_OFFLINE=1`:
  - `hutch pm exec -- tsc --noEmit` — exit 0, no diagnostics.
  - `hutch pm exec -- vite build && hutch electrobun build --env=dev` — exit 0:

```text
../../dist/assets/noe-f11-BHSwU1Qc.svg       16.48 kB │ gzip:  1.20 kB
../../dist/assets/index-D9qs7LyX.css          5.90 kB │ gzip:  1.84 kB
../../dist/assets/index-Co1BglHV.js         161.94 kB │ gzip: 52.47 kB
✓ built in 411ms
hutch electrobun: macOS icon source not found: /Users/kwang/projects/octonoesis-wt/desktop-d1/desktop/icon.iconset
electrobun build complete: /Users/kwang/projects/octonoesis-wt/desktop-d1/desktop/build/dev-macos-arm64
```

- Focused host/reducer suite — `19 pass, 0 fail, 116 expect() calls` across 2 files.
- Mutation checks — deliberately broken mode switching and the original incorrect `+3 −4 lines` summary both failed the targeted real-host test; temporary mutants were removed.
- Playwright skill browser QA used the actual React/CSS with a temporary local RPC adapter; adapter/configuration were removed afterward. The shipped webview still loads only `views://` and production output contains no QA adapter.
- Composer geometry: 20 cases at widths 800, 801, 1024, 1280, 1600px with 1/4/8/20 input lines. Minimum input/action-row gap: 12px. Maximum input height: 172px. Twenty-line inputs scroll (424px scroll height). Send and Stop both remain below the textarea.
- Permission UI: Bypass selection sends no command before confirmation; Cancel retains Ask. Confirming sends Bypass, then Accept edits and Ask switches succeed. Bypass text/border compute to `rgb(255, 200, 87)` (`#FFC857`).
- Browser QA artifacts: `/tmp/d1-delta-layout.log`, `/tmp/d1-delta-mode-ui.log`, `/tmp/d1-delta-composer-800.png`, `/tmp/d1-delta-bypass.png`.
- `git diff --check` — clean. No changes to dependencies, unrelated tests, `docs/`, `book/`, `cc-src/`, or `misc/`.

### Success Conditions

- [x] Permission mode switching — Ask/Accept edits/Bypass map to the existing engine mode setter; host acknowledgement follows ready; fresh sessions default to Ask; invalid modes error; Bypass confirms in-app and uses the amber warning pill. Subprocess tests prove real Edit/Bash execution, pending-request preservation, next-check switching, and deny-pattern precedence.
- [x] Composer overlap — flex column input/action rows and auto-height input capped at 172px; all 20 browser geometry cases pass, including Send/Stop checks.
- [x] Edit summary accuracy — actual line diff returns `+1 −2 lines` for a four-line old/three-line new replacement with unchanged context. Verified through helper/reducer tests and real host Edit completion.
- [x] All required root and desktop checks green; final outputs above.
- [x] New conventional commit on `feat/desktop-d1`: `fix(desktop): add permission modes and fix composer and Edit summaries`. Parent `dad849b` remains unchanged; this handoff is included.

### Risks & Deviations

- No scope deviations. The only shared engine change is the small mode setter; CLI configuration still emits its existing stderr warning and retains identical decision ordering. The host uses the setter without emitting that CLI warning. Pending permission promises are never settled by a mode switch.
- Edit line counts are corrected at the desktop host boundary, preserving existing TUI/one-shot output. Counts describe the actual diff of old_string versus new_string as requested; they do not attempt to multiply counts for replace_all matches elsewhere in a file.
- Browser acceptance checks use a local RPC adapter; real engine behavior is tested through subprocesses without API keys/network. Native end-to-end UI interaction and live providers were not rerun for this delta.
- Existing D1 limitations remain: development engine checkout required (standalone packaging is D4), and the absent seeded icon.iconset produces a nonfatal build warning.
- No new root or desktop dependencies. The root diff package computes summaries in the host; the webview does not import it.

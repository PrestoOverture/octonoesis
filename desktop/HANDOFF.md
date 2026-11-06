### Changed Files

- `biome.json` — Check desktop source in root style; ignore generated desktop directories.
- `bunfig.toml` — Keep dependency/build/SDK tests out of the root suite.
- `desktop/.gitignore` — Ignore installed SDK, dependencies, builds, and temporary Hutch files.
- `desktop/README.md` — Document offline development, host diagnostics, and D1 operation.
- `desktop/electrobun.config.ts` — Name the app, bundle local views, and embed the dev engine checkout path.
- `desktop/hutch.config.ts` — Pin Electrobun 2.0.6 and retain bundled-view development/build commands.
- `desktop/hutch.lock` — Commit the offline scaffold dependency lock with exact direct versions.
- `desktop/llms.txt` — Include the seeded Electrobun API guidance.
- `desktop/package.json` — Pin desktop dependencies and remove unused Tailwind/HMR dependencies.
- `desktop/src/bun/index.ts` — Native picker, typed RPC, per-session child relay, and bounded close/quit teardown.
- `desktop/src/mainview/App.tsx` — Welcome/Session views, text streaming, composer, Stop, and Y/A/N diff dialog.
- `desktop/src/mainview/assets/noe-compact.svg` — Include the seeded compact Noe mascot.
- `desktop/src/mainview/assets/noe-f11.svg` — Include the seeded Welcome-screen Noe mascot.
- `desktop/src/mainview/index.css` — Apply D0 layout and color tokens with local font fallbacks.
- `desktop/src/mainview/index.html` — Local React webview entry.
- `desktop/src/mainview/main.tsx` — Mount the React application safely.
- `desktop/src/shared/rpc.ts` — Declare the minimal typed app/host RPC boundary.
- `desktop/src/shared/transcript.test.ts` — Verify all required reducer transitions without importing Electrobun.
- `desktop/src/shared/transcript.ts` — Pure transcript, permission, failure, and status reducer.
- `desktop/tsconfig.json` — Typecheck desktop separately using ES2022 and projected SDK types.
- `desktop/vite.config.ts` — Bundle React and local assets with relative view paths.
- `src/cli.tsx` — Reuse extracted interactive lifecycle helpers while preserving TUI/one-shot behavior.
- `src/host/main.ts` — Persistent interactive NDJSON subprocess host, permissions, cancellation, and shutdown.
- `src/host/protocol.ts` — Versioned commands/messages and command validation.
- `src/session/lifecycle.ts` — Share config/trust, memory, sandbox, context, cleanup, and signal handling.
- `test/fixtures/host/preload.ts` — Inject the existing provider boundary for deterministic subprocess tests.
- `test/integration/host-protocol.test.ts` — Exercise the actual host, real Write permissions, cleanup, malformed input, and busy turns.
- `tsconfig.json` — Exclude desktop from the root TypeScript project.
- `desktop/HANDOFF.md` — Record changed files, validation evidence, success audit, and limitations.

### Validation

- Root dependencies restored using `bun install --offline --frozen-lockfile`; root manifests and lock unchanged.
- `npx tsc --noEmit` — exit 0, no diagnostics.
- `bun run lint` — exit 0: `Checked 395 files ... No fixes applied.`
- `bun run build` — exit 0: `Bundled 822 modules ... cli.js 4.17 MB`.
- `timeout 600 bun test > /tmp/d1-bun-test.log 2>&1` — exit 0:

```text
 1242 pass
 0 fail
 18148 expect() calls
Ran 1242 tests across 208 files. [116.45s]
```

- `CI=true timeout 600 bun test > /tmp/d1-ci-bun-test.log 2>&1` — exit 0:

```text
 1242 pass
 0 fail
 17945 expect() calls
Ran 1242 tests across 208 files. [108.10s]
```
- In `desktop/`, with `PATH="$HOME/.hutch/bin:$PATH" DASH_RELEASE_OFFLINE=1`:
  - `hutch install --frozen-lockfile` — exit 0: `Checked 76 installs across 127 packages (no changes)`.
  - `hutch pm exec -- tsc --noEmit` — exit 0, no diagnostics.
  - `hutch pm exec -- vite build && hutch electrobun build --env=dev` — exit 0:

```text
../../dist/assets/noe-f11-BHSwU1Qc.svg       16.48 kB │ gzip:  1.20 kB
../../dist/assets/index-CJv-wKNw.css          5.07 kB │ gzip:  1.63 kB
../../dist/assets/index-0JtpBJOs.js         160.02 kB │ gzip: 51.85 kB
✓ built in 558ms
hutch electrobun: macOS icon source not found: /Users/kwang/projects/octonoesis-wt/desktop-d1/desktop/icon.iconset
electrobun build complete: /Users/kwang/projects/octonoesis-wt/desktop-d1/desktop/build/dev-macos-arm64
```

- Focused subprocess/reducer suite — `13 pass, 0 fail, 62 expect() calls` across 2 files.
- Mutation audit — all 9 deliberately broken variants failed their targeted host test: ready-first, stdout purity, allow, deny, cancel, signal exit, shutdown cleanup, malformed input, busy submit. Mutant files were removed.
- Native macOS smoke test — inspected Welcome and Session screens, used the native folder picker (including a selection after more than 15 seconds), connected a real host, and closed the active session via Window → Close Window. The original app/host processes exited; the host logged its session summary.
- `git diff --cached --check` — clean. No existing tests changed; forbidden directories and root dependency files unchanged.

### Success Conditions

- [x] Root typecheck, lint, normal test and CI-mode test commands all green; command outputs above.
- [x] Desktop typecheck and Vite/Electrobun development build pass, with frozen lock.
- [x] Host subprocess tests prove ready-first, event/turn completion with schema-validated stdout, allow_once executes/deny blocks the real Write tool, cancel then resubmit, busy-submit errors, malformed-input survival, and SIGTERM/shutdown exit 0 within 3 seconds after journal/session cleanup. Nine mutations prove these tests detect broken behavior.
- [x] Reducer tests cover delta concatenation, tool running → done/error, permission open → resolved, failures, and session_state → status values.
- [x] Committed on `feat/desktop-d1` with `feat(desktop): add D1 session host and desktop shell`, including the seeded scaffold and this structured handoff.

### Risks & Deviations

- Startup/trust diagnostics, session summary, memory and journal notices are deliberately sent to host stderr and relayed to the main-process log. Stdout contains protocol only.
- Development builds depend on this engine checkout (or `OCTONOESIS_ENGINE_ROOT`); standalone packaging is D4, as specified.
- The seeded `icon.iconset` is absent. Electrobun reports the warning shown above but builds successfully.
- Native smoke coverage includes picker, session connection and close teardown. Live-provider requests and native permission-dialog interactions were not exercised end-to-end; deterministic subprocess and reducer tests cover streaming, permissions, cancellation and errors without real API keys/network.
- System font fallbacks are used, as allowed. No right panel, grouped tools, markdown rendering, or provider-settings feature was added.
- No scope deviations; no new root dependencies, existing-test edits, or changes under `docs/`, `book/`, `cc-src/`, or `misc/`.

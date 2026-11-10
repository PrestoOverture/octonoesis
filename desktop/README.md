# Octonoesis desktop

Electrobun 2.0.6 desktop app. The React webview talks to the Bun main process, and the main
process runs one stdio engine host (`src/host/main.ts`, NDJSON protocol v1) per session, with
the session's repository as its working directory. See ADR-011 in the engine's architecture
notes.

## Develop

Hutch drives every command:

```sh
export PATH="$HOME/.hutch/bin:$PATH"
hutch install --frozen-lockfile
hutch pm exec -- tsc --noEmit
hutch run start        # vite build + dev build + launch
```

Install Hutch with its installer: `curl -fsSL https://hutch.blackboard.sh/hutch/install.sh | sh -s -- --version 0.29.0`. `hutch electrobun dev` copies only
`dist/`, so run `vite build` first (`hutch run start` does). Dev builds run the engine straight
from this checkout; the path is embedded at build time, and `OCTONOESIS_ENGINE_ROOT`
overrides it.

Dev builds also read `OCTONOESIS_DEV_*` launch options for unattended review:
`OPEN=<repo>`, `PROMPT`, `PERMISSION_MODE=bypass|accept-edits`, `SCREEN=settings`,
`PANEL=changes|timeline|learning`, `TRACE=1`. Packaged builds ignore all of them.

## Package

```sh
hutch run build        # stable: artifacts/macos-arm64-Octonoesis.dmg
```

The build runs `scripts/build-engine.ts` first. That script bundles the engine host into
`engine/host.js`, and the app runs that bundle with its own Bun, so a packaged app needs
neither Bun nor this checkout. The platform's ripgrep goes alongside it in
`engine/node_modules/@vscode/`, where the bundled `@vscode/ripgrep` resolves it. A packaged
app starts the engine with the PATH from the user's login shell; launched from Finder, it
would otherwise get launchd's minimal PATH.

The `.app` in the DMG is Electrobun's self-extracting wrapper: on first launch it unpacks in
place, and later launches run the full app.

Signing: builds are ad-hoc signed by default. When `ELECTROBUN_DEVELOPER_ID` is set, they are
signed with Developer ID and notarized. That also needs `ELECTROBUN_TEAMID`, plus either
`ELECTROBUN_APPLEID` / `ELECTROBUN_APPLEIDPASS` or `ELECTROBUN_APPLEAPIKEY` /
`ELECTROBUN_APPLEAPIISSUER`. The `Desktop` workflow builds the DMG on every PR, smoke-tests the
packaged engine, and attaches the DMG to tagged releases. It passes those variables through
from repository secrets when they exist.

`scripts/icon.ts` regenerates `icon.iconset` from the Noe pixel art (needs ffmpeg).

The reducer and helper tests under `src/shared/` run in the root `bun test` suite.

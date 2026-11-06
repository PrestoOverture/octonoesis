# Octonoesis desktop D1

Single-session Electrobun 2.0.6 desktop shell. The React webview loads bundled
`views://` assets. Open repository uses a native directory picker, then launches
one stdio engine host with that repository as its working directory.

Run all Hutch commands with the offline release environment:

```sh
export PATH="$HOME/.hutch/bin:$PATH"
export DASH_RELEASE_OFFLINE=1
hutch install --frozen-lockfile
hutch pm exec -- tsc --noEmit
hutch pm exec -- vite build
hutch electrobun build --env=dev
hutch electrobun dev
```

The development build embeds the engine checkout path at build time. Override
it with `OCTONOESIS_ENGINE_ROOT` when moving the build. Provider credentials and
configuration use the engine's existing environment/configuration. Packaging a
standalone engine is D4.

The host's stdout is versioned NDJSON only; diagnostics, startup warnings,
session summary, and memory/journal notices go to stderr and the app log.
Enter sends, Shift/Option+Enter inserts a newline, and Stop cancels the current
turn. Permission decisions use Y (once), A (session, exact tool input), N (deny).

The reducer tests run in the root `bun test` suite without loading Electrobun.

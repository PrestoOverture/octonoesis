// Shared helper for restoring a process.env var to its captured original value in
// test teardown.
//
// Bun 1.4.0 changed `process.env.KEY = value` to Node-compatible ToString-coercion
// semantics: assigning `undefined` (directly, or indirectly via a variable that
// captured an absent env var) writes the literal string "undefined" instead of
// deleting the key. Bun 1.3.14 special-cased that assignment as a delete, which is
// why this class of bug was invisible on this machine and only surfaced in CI.
//
// A "restore" is exactly the case a hand-written `if (original === undefined) ...
// else ...` guard should cover, but 17 call sites across the suite just did
// `process.env.KEY = original` directly, trusting `original` was a real string
// without checking. When `original` was `undefined` (the normal case for a variable
// nothing else in the environment sets, e.g. OCTONOESIS_REPO_ROOT), that direct
// assignment landed on the same bug.
//
// Route every teardown restore through this function instead of writing the
// if/else by hand -- see test/unit/ledger-isolation.test.ts's
// "unguarded env restores" test, which fails the whole suite if a new bare
// `process.env.KEY = <identifier>` restore is introduced anywhere under test/.
export function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key)
  } else {
    process.env[key] = value
  }
}

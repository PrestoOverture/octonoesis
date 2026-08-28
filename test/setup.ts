// Preloaded by `bunfig.toml` ([test].preload) before every test file runs.
//
// Guarantees no test can ever write into the repo's real `.octonoesis/` ledger,
// regardless of execution order: any test that exercises a journal/stats/task-log
// writer without first pointing OCTONOESIS_MEMORY_DIR at its own temp directory
// would otherwise fall through to getMemoryDir()'s repo-root default and corrupt
// the project's live observation data.
//
// Tests that manage their own memory dir (setting OCTONOESIS_MEMORY_DIR in
// beforeEach/afterEach) must keep winning, so this only fills in the variable
// when it is not already set.
// Deliberately synchronous (mkdtempSync, not the promises API): a top-level
// `await` here would let Bun start importing/running test files before this
// preload's env var assignment lands, racing the very isolation it exists to
// guarantee. Synchronous calls finish before this module — and therefore
// this preload — is considered loaded.
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getRepoRoot } from '../src/utils/path'

// getRepoRoot() caches its `git rev-parse --show-toplevel` result in a
// process-global singleton the first time it's called with no
// OCTONOESIS_REPO_ROOT override. Several tests `process.chdir()` into a
// throwaway temp repo for the duration of one test; if that chdir'd test
// happened to be the first-ever uncached caller, the real repo root would be
// permanently poisoned with the temp path for the rest of the run. Priming
// the cache here — before any test file can chdir anywhere — makes that
// first call happen while the cwd is still the real repo root, exactly once,
// deterministically, regardless of test execution order.
getRepoRoot()

if (!process.env.OCTONOESIS_MEMORY_DIR) {
  process.env.OCTONOESIS_MEMORY_DIR = mkdtempSync(path.join(os.tmpdir(), 'octonoesis-test-memory-'))
}

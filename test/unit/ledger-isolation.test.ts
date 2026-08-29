import { describe, expect, it } from 'bun:test'
import path from 'node:path'
import { getMemoryDir, getRepoRoot } from '../../src/utils/path'

// This is the single regression guard for the whole "no test may write into the
// real .octonoesis/ ledger" invariant (see test/setup.ts and
// scripts/check-ledger-isolation.sh). Every journal/stats/task-log writer in
// src/ resolves its directory via getMemoryDir(), so asserting that
// getMemoryDir() does not fall through to the repo-root default is sufficient
// to cover the whole class of writers, not just this one call site.
//
// If this test fails, either the bunfig.toml [test].preload entry pointing at
// test/setup.ts was removed, or test/setup.ts stopped setting
// OCTONOESIS_MEMORY_DIR before this file ran.
describe('ledger isolation', () => {
  it('getMemoryDir() does not resolve to <repoRoot>/.octonoesis while the test preload is active', () => {
    const repoDefault = path.join(getRepoRoot(), '.octonoesis')
    expect(getMemoryDir()).not.toBe(repoDefault)
  })
})

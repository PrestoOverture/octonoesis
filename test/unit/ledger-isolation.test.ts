import { describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
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

// --- Unguarded env-restore audit -------------------------------------------------
//
// Bun 1.4.0 made `process.env.KEY = value` coerce via ToString: assigning a
// variable that captured an absent env var (`const original = process.env.KEY`,
// where KEY was never set) writes the literal string "undefined" instead of
// deleting the key. Bun 1.3.14 (this machine) special-cased that assignment as a
// delete, so the bug is invisible locally and only shows up on CI's 1.4.0 runner --
// where it poisons the env var for every test that runs afterward in the same
// process (see the getRepoRoot()/getMemoryDir() blast radius this exact bug caused
// in test/benchmark/rebuild-scale.test.ts).
//
// A previous pass fixed 17 known unguarded sites, but a plain manual audit rots --
// it's advisory, not enforced. This test makes the invariant self-checking: it
// statically scans every .ts/.tsx file under test/ and src/ for the shape
//     process.env.KEY = someVariable
// where `someVariable` was itself populated by reading `process.env.SOMEKEY`
// earlier in the same file (i.e. it is plausibly `undefined`), and fails, naming
// file:line, unless that assignment is either:
//   (a) guarded by an `if (someVariable === undefined) ...` check nearby, or
//   (b) not a direct assignment at all -- i.e. routed through test/helpers/env.ts's
//       restoreEnv(key, value), which performs exactly that guard internally and
//       therefore never appears as a `process.env.KEY = ...` assignment in the
//       first place.
//
// This intentionally does NOT flag `process.env.KEY = someLiteralOrFreshValue`
// (e.g. `process.env.OCTONOESIS_MEMORY_DIR = tempDir` in a beforeEach) -- those
// assign a freshly-created value, not a captured original, and can never be the
// string "undefined" no matter which Bun version runs them.
const CAPTURED_FROM_ENV_RE = /(?<![.\w])(\w+)\s*=\s*process\.env\.([A-Z][A-Z0-9_]*)\b/g
const RESTORE_ASSIGNMENT_RE = /process\.env\.([A-Z][A-Z0-9_]*)\s*=\s*(\w+)\b/
const GUARD_WINDOW_LINES = 4

async function findSourceFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        await walk(full)
      } else if (entry.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) {
        out.push(full)
      }
    }
  }
  await walk(root)
  return out
}

function isGuarded(lines: string[], assignmentLineIndex: number, varName: string): boolean {
  const start = Math.max(0, assignmentLineIndex - GUARD_WINDOW_LINES)
  const window = lines.slice(start, assignmentLineIndex + 1).join('\n')
  const guardRe = new RegExp(`if\\s*\\(\\s*${varName}\\s*===\\s*undefined\\s*\\)`)
  return guardRe.test(window)
}

describe('unguarded env-restore audit', () => {
  it('every process.env.KEY = <captured-original> restore is guarded or routed through restoreEnv', async () => {
    const repoRoot = getRepoRoot()
    const files = [
      ...(await findSourceFiles(path.join(repoRoot, 'test'))),
      ...(await findSourceFiles(path.join(repoRoot, 'src'))),
    ]

    const offenders: string[] = []

    for (const file of files) {
      const text = await fs.readFile(file, 'utf8')
      const lines = text.split('\n')

      const capturedVars = new Set<string>()
      for (const match of text.matchAll(CAPTURED_FROM_ENV_RE)) {
        const varName = match[1]
        if (varName) capturedVars.add(varName)
      }
      if (capturedVars.size === 0) continue

      lines.forEach((line, index) => {
        const match = line.match(RESTORE_ASSIGNMENT_RE)
        if (!match) return
        const rhsVar = match[2]
        if (!rhsVar || !capturedVars.has(rhsVar)) return // a fresh value, not a captured original
        if (isGuarded(lines, index, rhsVar)) return

        const relative = path.relative(repoRoot, file)
        offenders.push(`${relative}:${index + 1}: ${line.trim()}`)
      })
    }

    expect(offenders).toEqual([])
  })
})

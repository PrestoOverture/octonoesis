import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { runSessionEndEpisodes } from '../../../../src/memory/episodes/hook'
import { readEpisodes } from '../../../../src/memory/episodes/store'

describe('Episode Session-End Hook', () => {
  const tempDir = join(os.tmpdir(), `octonoesis-hook-test-${Date.now()}`)
  let originalMemoryDir: string | undefined

  beforeAll(async () => {
    originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
    process.env.OCTONOESIS_MEMORY_DIR = tempDir
    await rm(tempDir, { recursive: true, force: true })
    await mkdir(tempDir, { recursive: true })
  })

  afterAll(async () => {
    if (originalMemoryDir === undefined) {
      process.env.OCTONOESIS_MEMORY_DIR = undefined
    } else {
      process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
    }
    await rm(tempDir, { recursive: true, force: true })
  })

  it('should parse active session events and record new episodes', async () => {
    const journalPath = join(tempDir, 'journal.jsonl')
    const sessionId = 'session-999'

    const mockJournalLines = `${[
      JSON.stringify({
        ts: '2026-06-20T10:00:00.000Z',
        session_id: sessionId,
        kind: 'user',
        digest: 'digest-user-prompt',
        cancel: false,
      }),
      JSON.stringify({
        ts: '2026-06-20T10:01:00.000Z',
        session_id: sessionId,
        kind: 'tool',
        tool: 'Bash',
        input_digest: 'input-1',
        outcome: 'failure',
        error_class: 'TypeError',
        duration_ms: 1000,
        fingerprints: [
          {
            coarse: 'bash|TypeError',
            medium: 'bash|TypeError|src/bug.ts',
            fine: 'bash|TypeError|src/bug.ts|null pointer',
          },
        ],
      }),
      JSON.stringify({
        ts: '2026-06-20T10:02:00.000Z',
        session_id: sessionId,
        kind: 'tool',
        tool: 'Edit',
        input_digest: 'input-2',
        outcome: 'success',
        duration_ms: 500,
        path: 'src/bug.ts',
      }),
      JSON.stringify({
        ts: '2026-06-20T10:03:00.000Z',
        session_id: sessionId,
        kind: 'verify',
        verdict: 'PASS',
        fingerprints: [],
        command: 'bun test',
        exit_code: 0,
        stale: false,
      }),
    ].join('\n')}\n`

    await writeFile(journalPath, mockJournalLines, 'utf8')

    // Run the hook
    await runSessionEndEpisodes(sessionId)

    // Verify written episodes
    let episodes = await readEpisodes()
    expect(episodes.length).toBe(1)

    const ep = episodes[0]
    expect(ep).toBeDefined()
    expect(ep?.id).toBe('ep_0001')
    expect(ep?.outcome).toBe('resolved')
    expect(ep?.failure.signature).toBe('bash|TypeError|src/bug.ts|null pointer')
    expect(ep?.fix?.path).toBe('src/bug.ts')
    expect(ep?.value_score).toBe(1.0)
    expect(ep?.is_excluded).toBe(false)

    // Run the hook again (representing a retry or second query in a TUI session)
    await runSessionEndEpisodes(sessionId)

    // Verify we still have exactly 1 episode and no duplicates
    episodes = await readEpisodes()
    expect(episodes.length).toBe(1)
    expect(episodes[0]?.id).toBe('ep_0001')
  })
})

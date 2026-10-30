import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type StoredJournalEvent, segmentJournal } from '../../../../src/memory/episodes/segment'
import { parseJournalEvent } from '../../../../src/memory/events'
import { flushJournal, getSessionId, setSessionId } from '../../../../src/memory/journal'
import { distillEpisode } from '../../../../src/memory/rules/distill'
import { setProvider } from '../../../../src/providers'
import { initQueryState } from '../../../../src/query/engine'
import { restoreEnv } from '../../../helpers/env'

test('scrubbed task contract travels from query journal through episode to distillation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rule-task-context-'))
  const original = process.env.OCTONOESIS_MEMORY_DIR
  const originalSessionId = getSessionId()
  process.env.OCTONOESIS_MEMORY_DIR = dir
  try {
    const instruction =
      'invalidate removes pending ownership; old callers still settle. token=task-secret-value\n'
    await initQueryState(instruction + 'detail '.repeat(1200), {
      repoRoot: dir,
      sessionId: 'task-context',
    })
    await flushJournal()
    const text = await readFile(path.join(dir, 'journal.jsonl'), 'utf8')
    expect(text).not.toContain('task-secret-value')
    const user = parseJournalEvent(JSON.parse(text.trim())) as StoredJournalEvent
    expect(user.kind).toBe('user')
    const excerpt = user.kind === 'user' ? user.task_excerpt : undefined
    expect(excerpt?.length).toBe(6000)
    expect(excerpt).toContain('old callers still settle')
    const common = { session_id: 'task-context', ts: '2026-01-01T00:00:00Z' }
    const events: StoredJournalEvent[] = [
      user,
      {
        ...common,
        kind: 'tool',
        tool: 'Bash',
        input_digest: 'failed',
        outcome: 'failure',
        error_class: 'TypeError',
        duration_ms: 1,
        cmd: 'bun test',
        exit_code: 1,
        error_excerpt: 'old caller never settles',
        fingerprints: [
          {
            coarse: 'test|TypeError',
            medium: 'test|TypeError|case.ts',
            fine: 'test|TypeError|case.ts|get()',
          },
        ],
      },
      {
        ...common,
        kind: 'tool',
        tool: 'Edit',
        input_digest: 'fixed',
        outcome: 'success',
        error_class: null,
        duration_ms: 1,
        path: 'case.ts',
        fix_diff: 'settle only current -> settle every caller; guard cache ownership',
      },
      {
        ...common,
        kind: 'verify',
        command: 'bun test',
        verdict: 'PASS',
        exit_code: 0,
        stale: false,
        fingerprints: [],
      },
    ]
    const episode = segmentJournal(events.map((event, i) => ({ event, line: i + 1 })))[0]
    if (!episode) throw new Error('Missing episode')
    expect(episode.evidence?.taskExcerpt).toBe(excerpt)
    let prompt = ''
    setProvider({
      name: 'anthropic',
      createMessageStream: async function* (messages) {
        prompt = JSON.stringify(messages)
        yield { type: 'text_delta', text: '{"abstain":true}' }
      },
    })
    await expect(
      distillEpisode(episode, { model: 'mock', extractorVersion: 'test' }),
    ).rejects.toThrow('abstained')
    expect(prompt).toContain('old callers still settle')
    expect(prompt).not.toContain('task-secret-value')
    expect(prompt).toContain('Abstain if the proposed advice contradicts the task instructions')
  } finally {
    setProvider(null)
    setSessionId(originalSessionId ?? '')
    await flushJournal()
    restoreEnv('OCTONOESIS_MEMORY_DIR', original)
    await rm(dir, { recursive: true, force: true })
  }
})

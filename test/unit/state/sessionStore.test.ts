import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  listSessions,
  loadMostRecentSession,
  loadSession,
  saveSession,
} from '../../../src/state/sessionStore.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempMemoryDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-session-store-'))
  tempDirs.push(dir)
  return dir
}

describe('session store', () => {
  it('atomically round-trips one structurally valid canonical conversation', async () => {
    const memoryDir = await tempMemoryDir()
    await saveSession(
      {
        sessionId: 'session-one',
        model: 'test-model',
        repoRoot: '/repo',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'remember the canary' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Canary remembered.' }] },
        ],
      },
      { memoryDir, now: new Date('2026-07-17T01:02:03.000Z') },
    )

    const loaded = await loadSession('session-one', { memoryDir })

    expect(loaded).toEqual({
      schema_version: 1,
      session_id: 'session-one',
      updated_at: '2026-07-17T01:02:03.000Z',
      model: 'test-model',
      repo_root: '/repo',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'remember the canary' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Canary remembered.' }] },
      ],
    })
    expect(await fs.readdir(path.join(memoryDir, 'sessions'))).toEqual(['session-one.json'])
  })

  it('rejects corrupt and dangling sessions without mutating either file', async () => {
    const memoryDir = await tempMemoryDir()
    const sessionsDir = path.join(memoryDir, 'sessions')
    await fs.mkdir(sessionsDir, { recursive: true })
    const corruptPath = path.join(sessionsDir, 'corrupt.json')
    const danglingPath = path.join(sessionsDir, 'dangling.json')
    const corruptBytes = '{not json\n'
    const danglingBytes = `${JSON.stringify({
      schema_version: 1,
      session_id: 'dangling',
      updated_at: '2026-07-17T01:02:03.000Z',
      model: 'test-model',
      repo_root: '/repo',
      messages: [
        { role: 'user', content: 'run a tool' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.ts' } }],
        },
      ],
    })}\n`
    await fs.writeFile(corruptPath, corruptBytes)
    await fs.writeFile(danglingPath, danglingBytes)

    await expect(loadSession('corrupt', { memoryDir })).rejects.toThrow(
      'Invalid saved session corrupt',
    )
    await expect(loadSession('dangling', { memoryDir })).rejects.toThrow(
      'dangling tool_use id tool-1',
    )
    expect(await fs.readFile(corruptPath, 'utf8')).toBe(corruptBytes)
    expect(await fs.readFile(danglingPath, 'utf8')).toBe(danglingBytes)
  })

  it('evicts to the 50 most-recent sessions and resolves continue within one repo', async () => {
    const memoryDir = await tempMemoryDir()
    for (let index = 0; index < 52; index += 1) {
      const suffix = index.toString().padStart(2, '0')
      await saveSession(
        {
          sessionId: `session-${suffix}`,
          model: 'test-model',
          repoRoot: index === 51 ? '/other-repo' : '/repo',
          messages: [{ role: 'user', content: `prompt ${suffix}` }],
        },
        {
          memoryDir,
          now: new Date(Date.UTC(2026, 6, 17, 0, 0, index)),
        },
      )
    }

    const listed = await listSessions({ memoryDir })
    const continued = await loadMostRecentSession('/repo', { memoryDir })

    expect(listed.length).toBe(50)
    expect(listed[0]?.session_id).toBe('session-51')
    expect(listed[49]?.session_id).toBe('session-02')
    expect(continued?.session_id).toBe('session-50')
    expect(await fs.readdir(path.join(memoryDir, 'sessions'))).not.toContain('session-00.json')
    expect(await fs.readdir(path.join(memoryDir, 'sessions'))).not.toContain('session-01.json')
  })
})

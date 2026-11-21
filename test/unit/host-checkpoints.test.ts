import { expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkpointTimeline, sessionChanges } from '../../src/host/checkpoints'
import { historyEntries, rewindNotice, sessionSummaries } from '../../src/host/history'
import { loadFileHistory, writeWithCheckpoint } from '../../src/state/fileHistory'
import type { ToolContext } from '../../src/tools/Tool'

async function session(run: (dir: string, ctx: ToolContext) => Promise<void>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'octonoesis-changes-')))
  const ctx = { repoRoot: dir, memoryDir: join(dir, '.memory'), sessionId: 's1' } as ToolContext
  try {
    await run(dir, ctx)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('changes compare each file before its first write with the disk now', async () => {
  await session(async (dir, ctx) => {
    await writeFile(join(dir, 'kept.txt'), 'a\nb\n')
    await writeFile(join(dir, 'gone.txt'), 'bye\n')
    await writeFile(join(dir, 'same.txt'), 'x\n')
    await writeWithCheckpoint(ctx, 'Edit', join(dir, 'kept.txt'), 'a\nc\n')
    await writeWithCheckpoint(ctx, 'Edit', join(dir, 'kept.txt'), 'a\nc\nd\n')
    await writeWithCheckpoint(ctx, 'Write', join(dir, 'new.txt'), 'hello\n')
    await writeWithCheckpoint(ctx, 'Write', join(dir, 'gone.txt'), 'later\n')
    await writeWithCheckpoint(ctx, 'Write', join(dir, 'same.txt'), 'y\n')
    await writeWithCheckpoint(ctx, 'Write', join(dir, 'bin.dat'), 'z')
    await rm(join(dir, 'gone.txt'))
    await writeFile(join(dir, 'same.txt'), 'x\n')
    await writeFile(join(dir, 'bin.dat'), Buffer.from([0, 1, 2]))
    const history = await loadFileHistory(ctx.memoryDir as string, 's1', dir)
    const changes = await sessionChanges(ctx.memoryDir as string, 's1', history)
    expect(
      changes.map(({ path, status, added, removed, note }) => ({
        path,
        status,
        added,
        removed,
        note,
      })),
    ).toEqual([
      { path: 'bin.dat', status: 'added', added: 0, removed: 0, note: 'binary' },
      { path: 'gone.txt', status: 'deleted', added: 0, removed: 1, note: undefined },
      { path: 'kept.txt', status: 'modified', added: 2, removed: 1, note: undefined },
      { path: 'new.txt', status: 'added', added: 1, removed: 0, note: undefined },
    ])
    expect(changes.find((change) => change.path === 'kept.txt')?.patch).toBe(
      '@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d',
    )
    expect(
      checkpointTimeline(history).entries.map((entry) => [entry.seq, entry.path, entry.created]),
    ).toEqual([
      [1, 'kept.txt', false],
      [2, 'kept.txt', false],
      [3, 'new.txt', true],
      [4, 'gone.txt', false],
      [5, 'same.txt', false],
      [6, 'bin.dat', true],
    ])
    expect(checkpointTimeline(undefined)).toEqual({ entries: [], commands: [] })
  })
})

test('changes never read through a symlink that now leads outside the repository', async () => {
  await session(async (dir, ctx) => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'octonoesis-outside-')))
    try {
      await writeFile(join(outside, 'secret.txt'), 'secret\n')
      await writeWithCheckpoint(ctx, 'Write', join(dir, 'link.txt'), 'mine\n')
      await rm(join(dir, 'link.txt'))
      await symlink(join(outside, 'secret.txt'), join(dir, 'link.txt'))
      const history = await loadFileHistory(ctx.memoryDir as string, 's1', dir)
      expect(await sessionChanges(ctx.memoryDir as string, 's1', history)).toEqual([])
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret\n')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

test('a rewind notice is hidden from replay and previews', () => {
  expect(rewindNotice([])).toBe('')
  const prompt = `${rewindNotice(['Before checkpoint 2: restored a.ts'])}fix it`
  expect(prompt).toContain('restored a.ts')
  expect(historyEntries([{ role: 'user', content: prompt }])).toEqual([
    { type: 'task_notice', text: 'Files were rewound before this turn' },
    { type: 'user', text: 'fix it' },
  ])
  expect(
    sessionSummaries([
      {
        session_id: 'x',
        updated_at: '2026-11-07T00:00:00.000Z',
        repo_root: '/r',
        messages: [{ role: 'user', content: prompt }],
      } as never,
    ])[0]?.preview,
  ).toBe('fix it')
})

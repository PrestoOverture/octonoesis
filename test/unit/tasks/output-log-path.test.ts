import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { flushJournal } from '../../../src/memory/journal'
import type { QueryLoopContext } from '../../../src/query/types'
import {
  cleanupTasks,
  drainTaskNotifications,
  taskLogPath,
  taskOutputLogPath,
} from '../../../src/tasks/framework'
import { bashTool } from '../../../src/tools/Bash'
import { restoreEnv } from '../../helpers/env'

for (const inside of [true, false]) {
  test(`background output_log matches notification and existing log: ${inside ? 'inside' : 'outside'}`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-log-path-'))
    const repoRoot = path.join(directory, 'repo')
    await fs.mkdir(repoRoot)
    const saved = process.env.OCTONOESIS_MEMORY_DIR
    process.env.OCTONOESIS_MEMORY_DIR = path.join(inside ? repoRoot : directory, 'custom-memory')
    const ctx: QueryLoopContext = { repoRoot, tasks: new Map() }
    try {
      const result = await bashTool.call(
        { command: "printf 'log-content\\n'", run_in_background: true },
        ctx,
      )
      if (!result.ok) throw new Error(result.error)
      const output = JSON.parse(result.value)
      const task = ctx.tasks?.get(output.task_id)
      if (!task) throw new Error('Missing background task')
      expect(path.isAbsolute(output.output_log)).toBe(!inside)
      expect(path.resolve(repoRoot, output.output_log)).toBe(task.logPath)
      expect((await fs.stat(path.resolve(repoRoot, output.output_log))).isFile()).toBe(true)
      const deadline = Date.now() + 5000
      while (task.status === 'running') {
        if (Date.now() > deadline) throw new Error('Task did not complete')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const notices = await drainTaskNotifications(ctx)
      expect(notices.length).toBe(1)
      expect(notices[0]?.match(/<output_file>(.*?)<\/output_file>/)?.[1]).toBe(output.output_log)
      expect(notices[0]?.split('Last output:\n')[1]).toBe('log-content\n')
      expect(await fs.readFile(path.resolve(repoRoot, output.output_log), 'utf8')).toBe(
        'log-content\n',
      )
      const fallback = { ...task, id: 'missing-log-path', logPath: undefined }
      expect(path.resolve(repoRoot, await taskOutputLogPath(ctx, fallback))).toBe(
        await taskLogPath(fallback.id),
      )
    } finally {
      await cleanupTasks(ctx)
      await flushJournal()
      restoreEnv('OCTONOESIS_MEMORY_DIR', saved)
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
}

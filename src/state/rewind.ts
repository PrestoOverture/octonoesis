import readline from 'node:readline'
import { listFileHistory, loadFileHistory, planFileRestore, restoreFiles } from './fileHistory'

interface RewindOptions {
  list?: boolean
  session?: string
  to?: string
  yes?: boolean
  force?: boolean
}

async function confirmRestore(): Promise<boolean> {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout })
  process.stdout.write('Restore these files? [y/N] ')
  try {
    for await (const line of input) return line.trim().toLowerCase() === 'y'
    return false
  } finally {
    input.close()
  }
}

/** Keyless rewind command: inspect history or confirm and execute a restore plan. */
export async function runRewind(
  options: RewindOptions,
  repoRoot: string,
  memoryDir: string,
): Promise<void> {
  if (options.list) {
    if (options.session !== undefined || options.to !== undefined)
      throw new Error('--list cannot be combined with --session or --to')
    const sessions = await listFileHistory(memoryDir, repoRoot)
    console.log(
      sessions.length === 0
        ? 'No file history sessions.'
        : sessions
            .map((session) => `${session.id}  ${session.ts}  ${session.count} changes`)
            .join('\n'),
    )
    return
  }
  const sessionId = options.session ?? (await listFileHistory(memoryDir, repoRoot))[0]?.id
  if (!sessionId) throw new Error('No file history sessions for this repository')
  const history = await loadFileHistory(memoryDir, sessionId, repoRoot)
  if (options.to === undefined) {
    console.log(
      `Session ${sessionId}\n${history.entries.map((entry) => `${entry.seq} ${entry.tool} ${entry.path}  ${entry.ts}`).join('\n')}`,
    )
    return
  }
  const plan = planFileRestore(history, Number(options.to))
  console.log(`Rewind session ${sessionId} to before change ${options.to}:`)
  for (const item of plan)
    console.log(`${item.snapshot === 'absent' ? 'delete' : 'restore'} ${item.path}`)
  if (!options.yes && !(await confirmRestore())) {
    console.log('Cancelled.')
    return
  }
  await restoreFiles(memoryDir, sessionId, history, plan, options.force === true)
  console.log(`Restored ${plan.length} files.`)
}

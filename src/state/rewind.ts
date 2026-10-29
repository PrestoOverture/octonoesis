import readline from 'node:readline'
import {
  listFileHistory,
  loadFileHistory,
  planFileRestore,
  pruneFileHistory,
  restoreFiles,
} from './fileHistory'

interface RewindOptions {
  prune?: boolean
  days?: string
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
  retentionDays = 30,
): Promise<void> {
  if (options.prune) {
    const days = options.days === undefined ? retentionDays : Number(options.days)
    if (!Number.isSafeInteger(days) || days < 0)
      throw new Error('--days must be a non-negative integer')
    const removed = await pruneFileHistory(memoryDir, days, options.session)
    console.log(
      removed.length
        ? removed.map((id) => `Removed ${id}`).join('\n')
        : 'No file history sessions removed.',
    )
    return
  }
  if (options.days !== undefined) throw new Error('--days requires --prune')
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
      `Session ${sessionId}\n${Array.from({ length: history.entries.length + 1 }, (_, index) => [
        ...(index === 0
          ? []
          : [
              `${index} ${history.entries[index - 1]?.tool} ${history.entries[index - 1]?.path}  ${history.entries[index - 1]?.ts}`,
            ]),
        ...(history.commands ?? [])
          .filter((command) => command.afterSeq === index)
          .map((command) => `$ ${command.command}`),
      ])
        .flat()
        .join('\n')}`,
    )
    return
  }
  const plan = planFileRestore(history, Number(options.to))
  console.log(`Rewind session ${sessionId} to before change ${options.to}:`)
  for (const item of plan)
    console.log(`${item.snapshot === 'absent' ? 'delete' : 'restore'} ${item.path}`)
  const commands = (history.commands ?? []).filter(
    (command) => command.afterSeq >= Number(options.to) - 1,
  )
  if (commands.length) {
    console.log('These shell commands ran after this point and will NOT be reverted')
    for (const command of commands) console.log(`$ ${command.command}`)
  }
  if (!options.yes && !(await confirmRestore())) {
    console.log('Cancelled.')
    return
  }
  await restoreFiles(memoryDir, sessionId, history, plan, options.force === true)
  console.log(`Restored ${plan.length} files.`)
}

import chalk from 'chalk'

const isDebug = process.env.DEBUG === '1' || process.argv.includes('--debug')

/**
 * Logs debug messages to stderr when DEBUG=1 or the --debug CLI flag is active.
 * @param scope A short namespace label (e.g. 'api', 'tool').
 * @param args Additional values or objects to log.
 */
export function dbg(scope: string, ...args: unknown[]): void {
  if (!isDebug) return
  const timestamp = new Date().toISOString()
  const prefix = chalk.gray(`[${timestamp}] [${scope}]`)
  console.error(prefix, ...args)
}

import chalk from 'chalk'

const isDebug = process.env.DEBUG === '1' || process.argv.includes('--debug')

/**
 * Debug logger — writes to stderr only when DEBUG=1 or --debug flag is present.
 * @param scope  A short label like 'api', 'tool', 'retry'
 * @param args   Values to log (objects are auto-stringified)
 */
export function dbg(scope: string, ...args: unknown[]): void {
  if (!isDebug) return
  const timestamp = new Date().toISOString()
  const prefix = chalk.gray(`[${timestamp}] [${scope}]`)
  console.error(prefix, ...args)
}

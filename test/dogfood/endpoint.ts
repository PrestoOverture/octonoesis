import type { HeadlessResult } from '../../src/headless'
import type { CommandResult } from '../eval/run'

export function sessionStatus(
  cli: CommandResult,
  check: CommandResult,
  output?: HeadlessResult,
): 'PASS' | 'FAIL' | 'ERROR' {
  if (cli.timed_out || cli.signal || !output || check.timed_out || check.signal || check.code > 1)
    return 'ERROR'
  if (output.exit_reason === 'max_turns' && cli.code === 1) return 'FAIL'
  if (output.exit_reason !== 'completed' || cli.code !== 0) return 'ERROR'
  return check.code === 0 ? 'PASS' : 'FAIL'
}

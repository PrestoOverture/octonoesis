import { getResolvedModel } from '../providers/index.ts'
import { bashTool } from '../tools/Bash.ts'
import { defaultCachedExtractor } from './fingerprint/cache.ts'
import type { Fingerprint } from './fingerprint/extract.ts'
import { scrub } from './fingerprint/scrub.ts'
import { appendJournal } from './journal.ts'

export type VerifyVerdict = 'PASS' | 'FAIL' | 'PARTIAL'

export interface VerifyResult {
  verdict: VerifyVerdict
  fingerprints: Fingerprint[]
  command: string
  exit_code: number
  stale: boolean
  stdout?: string
  stderr?: string
}

/**
 * Runs a verification command (such as test or lint commands) in a detached subprocess.
 * Parses stderr/stdout for failure signatures using cached LLM extraction, logs a verify journal event,
 * and returns VerifyResult.
 * @param command The shell command to execute.
 * @param repoRoot The absolute path of the repository root.
 * @param signal Optional abort signal for cancellation.
 * @param isVerificationRun Whether this is a verification run.
 * @returns A promise resolving to the VerifyResult.
 */
export async function verify(
  command: string,
  repoRoot: string,
  signal?: AbortSignal,
  isVerificationRun = true,
): Promise<VerifyResult> {
  // Delegate process spawning, timeout watchdog, abort handling, and safety denylist
  // to the canonical bashTool implementation.
  const result = await bashTool.call({ command }, { repoRoot, abortSignal: signal })
  if (!result.ok) {
    throw new Error(result.error)
  }

  // Parse exit code, stdout, and stderr from the JSON tool value
  const parsed = JSON.parse(result.value)
  const exitCode = parsed.code
  const stdoutText = parsed.stdout
  const stderrText = parsed.stderr

  const fingerprints: Fingerprint[] = []
  const verdict: VerifyVerdict = exitCode === 0 ? 'PASS' : 'FAIL'

  if (exitCode !== 0) {
    const errorOutput = (stderrText || stdoutText || '').trim()
    if (errorOutput) {
      const scrubbed = scrub(errorOutput, repoRoot)
      const model = getResolvedModel()
      const fp = await defaultCachedExtractor.getOrCreate(scrubbed, command, { model })
      fingerprints.push(fp)
    }
  }

  const verifyResult: VerifyResult = {
    verdict,
    fingerprints,
    command,
    exit_code: exitCode,
    stale: false,
    stdout: stdoutText,
    stderr: stderrText,
  }

  // Emit verify journal event if requested
  if (isVerificationRun) {
    appendJournal({
      kind: 'verify',
      verdict,
      fingerprints,
      command,
      exit_code: exitCode,
      stale: false,
    })
  }

  return verifyResult
}

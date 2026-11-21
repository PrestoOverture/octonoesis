// An app opened from Finder inherits launchd's PATH (/usr/bin:/bin:…), so the engine's Bash tool
// would miss Homebrew, nvm and similar. Ask the user's login shell once, as terminal apps do.
const MARKER = '__OCTONOESIS_PATH__'

/** The PATH between markers; rc files may print anything around it. */
export function parseShellPath(output: string): string | undefined {
  const start = output.indexOf(MARKER)
  const end = start === -1 ? -1 : output.indexOf(MARKER, start + MARKER.length)
  const path = end === -1 ? '' : output.slice(start + MARKER.length, end).trim()
  return path.includes('/') ? path : undefined
}

/** Absolute shells only; anything else falls back to zsh, macOS's default. */
export function shellCommand(shell: string | undefined): string[] {
  const program = shell?.startsWith('/') ? shell : '/bin/zsh'
  return [program, '-ilc', `printf '%s%s%s' ${MARKER} "$PATH" ${MARKER}`]
}

/** Undefined when the shell fails, hangs past `timeoutMs` or prints no PATH. */
export async function loginShellPath(shell: string | undefined, timeoutMs = 5000) {
  try {
    const child = Bun.spawn(shellCommand(shell), {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: timeoutMs,
    })
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return code === 0 ? parseShellPath(output) : undefined
  } catch {
    return undefined
  }
}

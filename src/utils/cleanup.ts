import { activeSubprocesses } from '../tools/Bash'

/**
 * Terminates all active shell subprocesses by sending SIGTERM to their process groups, falling back to SIGKILL after a 5s grace period.
 */
export function killAllShellTasks(): void {
  const pidsToKill = Array.from(activeSubprocesses).map((proc) => (proc as { pid: number }).pid)

  for (const pid of pidsToKill) {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {}
    }
  }

  // After 5s grace period, send SIGKILL to any PIDs that are still active
  const timer = setTimeout(() => {
    for (const proc of activeSubprocesses) {
      const pproc = proc as { pid: number }
      if (pidsToKill.includes(pproc.pid)) {
        try {
          process.kill(-pproc.pid, 'SIGKILL')
        } catch {
          try {
            process.kill(pproc.pid, 'SIGKILL')
          } catch {}
        }
      }
    }
  }, 5000)

  // Unref the timer so it doesn't block the Bun process from exiting
  if (timer && typeof timer.unref === 'function') {
    timer.unref()
  }
}

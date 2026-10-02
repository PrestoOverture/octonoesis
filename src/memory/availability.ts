import fs from 'node:fs/promises'
import path from 'node:path'

/** Result of probing memory storage, including the path and errno when unusable. */
export type MemoryAvailability = { usable: true } | { usable: false; dir: string; code: string }

let availability: MemoryAvailability = { usable: true }

/** Creates the directory and checks write access with an exclusive, removable probe file. */
export async function probeMemoryDir(dir: string): Promise<MemoryAvailability> {
  try {
    await fs.mkdir(dir, { recursive: true })
    const probe = path.join(dir, `.octonoesis-probe-${process.pid}`)
    await fs.writeFile(probe, '', { flag: 'wx' })
    await fs.unlink(probe)
    return { usable: true }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN'
    return { usable: false, dir, code }
  }
}

/** Records memory availability for the current process. */
export function markMemoryAvailability(state: MemoryAvailability): void {
  availability = state
}

/** Returns the current process memory availability. */
export function getMemoryAvailability(): MemoryAvailability {
  return availability
}

/** Resets process memory availability to usable for test isolation. */
export function resetMemoryAvailability(): void {
  availability = { usable: true }
}

/** Checks whether memory is unavailable or disabled by OCTONOESIS_DISABLE_MEMORY. */
export function isMemoryDisabled(): boolean {
  const value = process.env.OCTONOESIS_DISABLE_MEMORY?.trim().toLowerCase()
  return !availability.usable || (!!value && ['1', 'true', 'yes', 'on'].includes(value))
}

/** Formats the session-end notice when memory storage is unavailable. */
export function formatMemoryUnavailableNotice(): string | undefined {
  return availability.usable
    ? undefined
    : `⚠ Memory was off this session: ${availability.dir} (${availability.code})`
}

/** Probes and records memory availability, warning once for each unavailable state. */
export async function initializeMemoryAvailability(dir: string): Promise<void> {
  const state = await probeMemoryDir(dir)
  const previous = getMemoryAvailability()
  markMemoryAvailability(state)
  if (
    !state.usable &&
    (previous.usable || previous.dir !== state.dir || previous.code !== state.code)
  ) {
    console.error(
      `⚠ Memory dir unusable: ${state.dir} (${state.code}) — running without memory (rules, recall, auto-memory off)`,
    )
  }
}

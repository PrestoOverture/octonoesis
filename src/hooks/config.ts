import type { z } from 'zod'
import { loadConfig } from '../config/load'
import type { hookSchema } from '../config/schema'

export type ConfiguredHook = z.infer<typeof hookSchema>

export async function loadHooksConfig(repoRoot: string): Promise<ConfiguredHook[]> {
  return (await loadConfig(repoRoot)).hooks
}

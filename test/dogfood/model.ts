import type { HeadlessResult } from '../../src/headless'
import type { Task } from './tasks'

export type Arm = 'rules-on' | 'rules-off'
export interface Job {
  id: string
  task: Task
  arm: Arm | 'train'
}
export interface Observation {
  job: Job
  status: 'PASS' | 'FAIL' | 'ERROR'
  output?: HeadlessResult
  fingerprints: string[]
  hits: number
  misses: number
  rules_before: number
  error?: string
  ledger: string
}
export interface Plan {
  version: 1
  mode: 'live' | 'dry-run'
  provider: string
  model: string
  registered_at: string
  source_hash: string
  stream_hash: string
  tasks: Task[]
  jobs: Job[]
  hypothesis: string
  metrics: Record<string, string>
  test: string
  sample_size: { training: number; pairs: number }
  stopping_rule: string
  calibration: {
    min_failure_rate: number
    max_failure_rate: number
    min_recurring_sessions: number
  }
}

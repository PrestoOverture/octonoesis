import type { HeadlessResult } from '../../src/headless'
import type { HiddenGroupResult } from './check'
import type { PowerDesign } from './power'
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
  duration_ms?: number
  public_status?: 'PASS' | 'FAIL' | 'ERROR'
  hidden_status?: 'PASS' | 'FAIL' | 'ERROR'
  first_attempt?: {
    source_hash: string
    public_status: 'PASS' | 'FAIL' | 'ERROR'
    hidden_status: 'PASS' | 'FAIL' | 'ERROR'
  }
  hidden_groups?: HiddenGroupResult[]
  observed_repair_failure?: boolean
  observed_repair_resolution?: boolean
}
export interface Plan {
  version: 1
  mode: 'live' | 'dry-run'
  provider: string
  model: string
  registered_at: string
  source_hash: string
  stream_seed: number
  stream_hash: string
  tasks: Task[]
  jobs: Job[]
  hypothesis: string
  metrics: Record<string, string>
  test: string
  sample_size: { training: number; pairs: number }
  power_design: PowerDesign
  stopping_rule: string
  evaluation_concurrency: number
  error_tolerance: {
    max_pair_fraction: number
    max_arm_count_difference: number
    max_training_fraction: number
  }
  calibration: {
    max_error_fraction: number
    min_failure_rate: number
    max_failure_rate: number
    min_recurring_sessions: number
    min_pooled: number
    min_per_family: number
    min_informative_families: number
    min_attempt_coverage: number
    min_signal_families: number
  }
}

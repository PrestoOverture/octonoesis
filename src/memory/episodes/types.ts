export interface Episode {
  id: string // e.g. ep_0001
  timestamp: string // ISO string
  session_id: string
  task_digest: string
  failure: {
    tool: string
    cmd: string
    error_class: string
    signature: string // fine or medium fingerprint
  }
  fix?: {
    tool: string
    path: string // repo-relative path of modified file
    summary: string // replacement summary
  }
  verification?: {
    cmd: string
    exit_code: number
  }
  outcome: 'resolved' | 'abandoned'
  journal_line_range: {
    start: number // 1-indexed line number in journal.jsonl
    end: number
  }
  value_score: number
  is_excluded: boolean
  exclusion_reason: string | null
}

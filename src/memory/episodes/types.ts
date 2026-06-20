export type FixCandidate = {
  tool: string // 'Edit' | 'Write'
  path: string // repo-relative file path
  summary: string
  role: 'direct' | 'related' | 'indirect'
}

export type AttributionStatus =
  | 'single_direct' // exactly one candidate, role is direct
  | 'multi_with_direct' // multiple candidates, at least one direct
  | 'indirect_only' // no direct candidate, but resolved
  | 'unattributable' // cannot determine

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
  fix_candidates: FixCandidate[]
  attribution: {
    status: AttributionStatus
    primary?: string
    confidence: number
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

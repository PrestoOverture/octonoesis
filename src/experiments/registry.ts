import fs from 'node:fs/promises'
import path from 'node:path'
import { dbg } from '../utils/debug.ts'
import { getMemoryDir } from '../utils/path.ts'
import { type ExperimentRecord, experimentRecordSchema } from './schema.ts'

export class ExperimentRegistryError extends Error {
  override name = 'ExperimentRegistryError'
}

const REGISTRY_FILE = 'experiments.jsonl'

/** Fields fixed at preregistration time; immutable once a same-id record has been appended. */
const PREREGISTERED_FIELDS: ReadonlyArray<keyof ExperimentRecord> = [
  'registered_at',
  'hypothesis',
  'endpoints',
  'test',
  'arms',
]

const STATUS_ORDER: Record<ExperimentRecord['status'], number> = {
  registered: 0,
  running: 1,
  concluded: 2,
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const aRecord = a as Record<string, unknown>
    const bRecord = b as Record<string, unknown>
    const aKeys = Object.keys(aRecord)
    const bKeys = Object.keys(bRecord)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every(
      (key) => Object.hasOwn(bRecord, key) && deepEqual(aRecord[key], bRecord[key]),
    )
  }

  return false
}

function preregisteredFieldsEqual(existing: ExperimentRecord, incoming: ExperimentRecord): boolean {
  return PREREGISTERED_FIELDS.every((field) => deepEqual(existing[field], incoming[field]))
}

/**
 * Reads and validates the append-only experiment registry, deduplicating by id with the
 * last line for a given id winning (ADR-004 episodes pattern). Malformed JSON lines and
 * schema-invalid records are skipped rather than failing the read. Pure: never creates the
 * memory dir or the registry file, and a missing file resolves to an empty array.
 * @param memoryDir Optional override for the persistent-data root.
 * @returns The deduplicated, validated experiment records.
 */
export async function readExperiments(
  memoryDir: string = getMemoryDir(),
): Promise<ExperimentRecord[]> {
  let content: string
  try {
    content = await fs.readFile(path.join(memoryDir, REGISTRY_FILE), 'utf8')
  } catch {
    return []
  }

  const byId = new Map<string, ExperimentRecord>()
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      continue
    }
    const parsed = experimentRecordSchema.safeParse(raw)
    if (!parsed.success) continue
    byId.set(parsed.data.id, parsed.data)
  }
  return Array.from(byId.values())
}

/**
 * Validates and appends an experiment record to the registry. A same-id record already on
 * disk must keep its preregistered fields (registered_at/hypothesis/endpoints/test/arms)
 * byte-for-byte and may only move status forward (registered -> running -> concluded, with
 * equal-status amendments allowed for result/decision/concluded_at on a concluded record) —
 * any violation throws ExperimentRegistryError before anything is written. Creates the
 * memory dir and registry file on first append.
 * @param record The candidate record (validated via schema before being trusted).
 * @param memoryDir Optional override for the persistent-data root.
 * @returns The validated, now-persisted record.
 */
export async function appendExperimentRecord(
  record: unknown,
  memoryDir: string = getMemoryDir(),
): Promise<ExperimentRecord> {
  const parsed = experimentRecordSchema.safeParse(record)
  if (!parsed.success) {
    throw new ExperimentRegistryError(`Invalid experiment record: ${parsed.error.message}`)
  }
  const incoming = parsed.data

  const existing = (await readExperiments(memoryDir)).find((entry) => entry.id === incoming.id)
  if (existing) {
    if (!preregisteredFieldsEqual(existing, incoming)) {
      throw new ExperimentRegistryError(
        `Experiment ${incoming.id} preregistered fields are immutable and cannot be amended`,
      )
    }
    if (STATUS_ORDER[incoming.status] < STATUS_ORDER[existing.status]) {
      throw new ExperimentRegistryError(
        `Experiment ${incoming.id} cannot move status backwards from ${existing.status} to ${incoming.status}`,
      )
    }
  }

  await fs.mkdir(memoryDir, { recursive: true })
  await fs.appendFile(path.join(memoryDir, REGISTRY_FILE), `${JSON.stringify(incoming)}\n`, 'utf8')
  return incoming
}

/**
 * Returns the experiment that session-start/post-failure injection should filter by: the
 * `running` experiment that declares arms. When several qualify, picks deterministically —
 * earliest `registered_at`, tiebroken by ascending id — and logs a debug warning so an
 * operator notices the ambiguity.
 * @param memoryDir Optional override for the persistent-data root.
 * @returns The active experiment, or null when none qualifies.
 */
export async function getActiveExperiment(
  memoryDir: string = getMemoryDir(),
): Promise<ExperimentRecord | null> {
  const running = (await readExperiments(memoryDir)).filter(
    (experiment) => experiment.status === 'running' && (experiment.arms?.length ?? 0) > 0,
  )
  if (running.length === 0) return null

  running.sort(
    (a, b) =>
      new Date(a.registered_at).getTime() - new Date(b.registered_at).getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  if (running.length > 1) {
    dbg('experiments', 'Multiple running experiments with arms; selecting earliest-registered', {
      selected: running[0]?.id,
      candidates: running.map((experiment) => experiment.id),
    })
  }
  return running[0] ?? null
}

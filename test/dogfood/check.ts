import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { extraGroups } from './extra-check'
import { extraGroups3 } from './extra-check3'
import type { ExtraSubject } from './extra-tasks'
import type { ExtraSubject3 } from './extra-tasks3'
import { type Family, clauses, families, specifications } from './tasks'

type Layer = { start: number; end: number; tag: string | null }
type Move = { from: string; to: string; amount: unknown; id?: unknown }
interface Subject extends ExtraSubject, ExtraSubject3 {
  createBus(): {
    on(
      event: string,
      listener: (...args: unknown[]) => unknown,
      options?: { once?: boolean },
    ): () => boolean
    emit(event: string, ...args: unknown[]): number
  }
  Pool: new (limit: number) => { run(job: () => unknown, signal?: AbortSignal): Promise<unknown> }
  overlay(layers: Layer[]): Layer[]
  transfer(balances: Record<string, unknown>, moves: Move[]): Record<string, unknown>
  Cache: new (
    loader: () => unknown,
    ttl: number,
    now: () => number,
  ) => {
    get(key: string): Promise<unknown>
    invalidate(key: string): void
  }
}
export interface AssertionGroup {
  id: string
  requires: readonly string[]
  run(subject: Subject, random: (n: number) => number, signal: AbortSignal): void | Promise<void>
}

function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void
  const promise = new Promise((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
async function until(predicate: () => boolean, signal: AbortSignal): Promise<void> {
  while (!predicate()) {
    signal.throwIfAborted()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/** Every executable assertion belongs to a group linked to verbatim agent-visible clauses. */
export const hiddenGroups: Record<Family, readonly AssertionGroup[]> = {
  ...extraGroups,
  ...extraGroups3,
  'interval-overlay': [
    {
      id: 'peel-history',
      requires: [clauses['interval-overlay'].domain, clauses['interval-overlay'].overlay],
      run(m) {
        const layers = [
          { start: 0, end: 8, tag: 'base' },
          { start: 0, end: 8, tag: 'x' },
          { start: 0, end: 8, tag: 'x' },
          { start: 2, end: 6, tag: null },
          { start: 3, end: 5, tag: null },
        ]
        assert.deepEqual(m.overlay(layers), [
          { start: 0, end: 3, tag: 'x' },
          { start: 3, end: 5, tag: 'base' },
          { start: 5, end: 8, tag: 'x' },
        ])
        assert.deepEqual(
          m.overlay([
            { start: -2, end: 2, tag: null },
            { start: 0, end: 1, tag: '' },
          ]),
          [{ start: 0, end: 1, tag: '' }],
        )
      },
    },
    {
      id: 'overlay-matrix',
      requires: Object.values(clauses['interval-overlay']),
      run(m, random) {
        for (let run = 0; run < 100; run++) {
          const layers = Array.from({ length: 12 }, () => {
            const start = random(30) - 15
            return {
              start,
              end: start + random(12),
              tag: random(4) === 0 ? null : (['', 'a', 'b'][random(3)] as string),
            }
          })
          const before = JSON.stringify(layers)
          const expected: Layer[] = []
          for (let x = -15; x < 27; x++) {
            const stack: string[] = []
            for (const layer of layers)
              if (layer.start <= x && x < layer.end) {
                if (layer.tag === null) stack.pop()
                else stack.push(layer.tag)
              }
            const tag = stack.at(-1)
            if (tag === undefined) continue
            const last = expected.at(-1)
            if (last && last.end === x && last.tag === tag) last.end++
            else expected.push({ start: x, end: x + 1, tag })
          }
          assert.deepEqual(m.overlay(layers), expected)
          assert.equal(JSON.stringify(layers), before)
        }
        assert.deepEqual(m.overlay([{ start: -1000000, end: 1000000, tag: 'x' }]), [
          { start: -1000000, end: 1000000, tag: 'x' },
        ])
      },
    },
  ],
  'atomic-transfer': [
    {
      id: 'retry-identities',
      requires: [
        clauses['atomic-transfer'].retries,
        clauses['atomic-transfer'].values,
        clauses['atomic-transfer'].final,
      ],
      run(m) {
        const move = { from: 'a', to: 'b', amount: 2, id: '' }
        const balances = { a: 4, b: 0 }
        assert.deepEqual({ ...m.transfer(balances, [move, { ...move }]) }, { a: 2, b: 2 })
        assert.deepEqual(
          {
            ...m.transfer(balances, [
              { ...move, id: undefined },
              { ...move, id: undefined },
            ]),
          },
          { a: 0, b: 4 },
        )
        assert.throws(() => m.transfer(balances, [move, { ...move, amount: 1 }]), RangeError)
        assert.throws(() => m.transfer(balances, [{ ...move, id: 0 }]), RangeError)
        const self = { from: 'a', to: 'a', amount: 1, id: '__proto__' }
        assert.throws(() => m.transfer(balances, [self, { ...self, to: 'b' }]), RangeError)
        assert.deepEqual(
          {
            ...m.transfer(balances, [
              { ...move, id: '__proto__' },
              { ...move, id: '__proto__' },
            ]),
          },
          { a: 2, b: 2 },
        )
        assert.deepEqual(balances, { a: 4, b: 0 })
      },
    },
    {
      id: 'wide-exact-net',
      requires: [clauses['atomic-transfer'].final, clauses['atomic-transfer'].immutable],
      run(m) {
        const M = Number.MAX_SAFE_INTEGER
        const balances = { a: 1, b: M, c: M, d: 0 }
        const moves = [
          { from: 'b', to: 'a', amount: M },
          { from: 'c', to: 'a', amount: M },
          { from: 'a', to: 'd', amount: 1 },
          { from: 'a', to: 'b', amount: M },
          { from: 'a', to: 'c', amount: M },
        ]
        const before = JSON.stringify([balances, moves])
        assert.deepEqual({ ...m.transfer(balances, moves) }, { a: 0, b: M, c: M, d: 1 })
        assert.equal(JSON.stringify([balances, moves]), before)
      },
    },
    {
      id: 'own-account-properties',
      requires: [clauses['atomic-transfer'].result, clauses['atomic-transfer'].ownKeys],
      run(m) {
        const special = JSON.parse('{"__proto__":5,"constructor":0,"a":10}')
        assert.deepEqual(
          { ...m.transfer(special, [{ from: '__proto__', to: 'constructor', amount: 5 }]) },
          JSON.parse('{"__proto__":0,"constructor":5,"a":10}'),
        )
        assert.throws(
          () => m.transfer({ a: 3 }, [{ from: 'a', to: 'toString', amount: 1 }]),
          RangeError,
        )
        assert.throws(
          () => m.transfer({ a: 3 }, [{ from: 'toString', to: 'a', amount: 1 }]),
          RangeError,
        )
      },
    },
    {
      id: 'invalid-values-and-final-overflow',
      requires: [clauses['atomic-transfer'].values, clauses['atomic-transfer'].final],
      run(m) {
        for (const amount of [
          -1,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          0.1,
          Number.MAX_SAFE_INTEGER + 1,
          '1',
          null,
        ])
          assert.throws(
            () => m.transfer({ a: 3, b: 0 }, [{ from: 'a', to: 'b', amount }]),
            RangeError,
          )
        assert.throws(() => m.transfer({ a: Number.NaN }, []), RangeError)
        assert.throws(
          () =>
            m.transfer({ a: 1, b: Number.MAX_SAFE_INTEGER }, [{ from: 'a', to: 'b', amount: 1 }]),
          RangeError,
        )
      },
    },
    {
      id: 'simultaneous-immutable-batch',
      requires: [
        clauses['atomic-transfer'].result,
        clauses['atomic-transfer'].final,
        clauses['atomic-transfer'].immutable,
      ],
      run(m, random) {
        for (let run = 0; run < 100; run++) {
          const a = random(10)
          const b = random(10)
          const n = random(20)
          const original = { a, b }
          const before = JSON.stringify(original)
          const moves = [
            { from: 'b', to: 'a', amount: n },
            { from: 'a', to: 'b', amount: n },
            { from: 'a', to: 'a', amount: Number.MAX_SAFE_INTEGER },
          ]
          Object.freeze(original)
          for (const move of moves) Object.freeze(move)
          Object.freeze(moves)
          assert.deepEqual({ ...m.transfer(original, moves) }, { a, b })
          assert.equal(JSON.stringify(original), before)
          assert.throws(
            () => m.transfer(original, [{ from: 'a', to: 'b', amount: a + 1 }]),
            RangeError,
          )
          assert.equal(JSON.stringify(original), before)
        }
      },
    },
  ],
  'single-flight': [
    {
      id: 'ttl-rangeerror',
      requires: [clauses['single-flight'].constructor],
      run(m) {
        for (const ttl of [0, -1, Number.POSITIVE_INFINITY, Number.NaN])
          assert.throws(
            () =>
              new m.Cache(
                () => 1,
                ttl,
                () => 0,
              ),
            RangeError,
          )
      },
    },
    {
      id: 'pending-invalidation-generations',
      requires: [
        clauses['single-flight'].pending,
        clauses['single-flight'].expiry,
        clauses['single-flight'].invalidation,
      ],
      async run(m, random, signal) {
        const deferred = () => {
          let resolve!: (v: unknown) => void
          let reject!: (e: Error) => void
          const promise = new Promise((a, b) => {
            resolve = a
            reject = b
          })
          return { promise, resolve, reject }
        }
        for (let run = 0; run < 12; run++) {
          let time = random(100)
          let calls = 0
          const old = deferred()
          const fresh = deferred()
          const c = new m.Cache(
            () => (++calls === 1 ? old.promise : fresh.promise),
            10,
            () => time,
          )
          // The contract does not require a particular microtask scheduling strategy.
          // The group deadline bounds a loader that never starts.
          const started = async (count: number) => {
            await until(() => calls >= count, signal)
            assert.equal(calls, count)
          }
          const p = c.get('x')
          const p2 = c.get('x')
          await started(1)
          c.invalidate('x')
          const newer = c.get('x')
          await started(2)
          time += 7
          fresh.resolve('fresh')
          assert.equal(await newer, 'fresh')
          time += 2
          if (run % 2) {
            const caught = p.catch(() => 'rejected')
            const caught2 = p2.catch(() => 'rejected')
            old.reject(new Error('old'))
            await caught
            await caught2
          } else {
            old.resolve('old')
            assert.equal(await p, 'old')
            assert.equal(await p2, 'old')
          }
          assert.equal(await c.get('x'), 'fresh')
          assert.equal(calls, 2)
          time += 8
          await c.get('x')
          assert.equal(calls, 3)
        }
      },
    },
    {
      id: 'undefined-expiry-independent-keys',
      requires: [clauses['single-flight'].pending, clauses['single-flight'].expiry],
      async run(m) {
        let time = 0
        let calls = 0
        const cache = new m.Cache(
          () => {
            calls++
            return undefined
          },
          5,
          () => time,
        )
        await cache.get('a')
        await cache.get('a')
        assert.equal(calls, 1)
        await cache.get('b')
        assert.equal(calls, 2)
        time = 5
        await cache.get('a')
        assert.equal(calls, 3)
      },
    },
    {
      id: 'synchronous-rejection-retry',
      requires: [clauses['single-flight'].rejection],
      async run(m) {
        let failures = 0
        const retry = new m.Cache(
          () => {
            if (++failures === 1) throw new Error('sync')
            return 9
          },
          5,
          () => 0,
        )
        let promise: Promise<unknown> | undefined
        assert.doesNotThrow(() => {
          promise = retry.get('a')
        })
        await assert.rejects(promise as Promise<unknown>)
        // A retained rejection contains the oracle loader's creation stack,
        // but returning it again violates the submitted cache's retry contract.
        await assert.doesNotReject(async () => {
          assert.equal(await retry.get('a'), 9)
        })
      },
    },
  ],
  'event-bus': [
    {
      id: 'snapshot-mutations',
      requires: [clauses['event-bus'].registration, clauses['event-bus'].snapshot],
      run(m) {
        const bus = m.createBus()
        const seen: string[] = []
        let added = false
        let off = () => false
        bus.on('x', () => {
          seen.push('a')
          off()
          if (!added) {
            added = true
            bus.on('x', () => seen.push('new'))
          }
        })
        off = bus.on('x', () => seen.push('removed'))
        bus.on('x', () => seen.push('b'))
        assert.equal(bus.emit('x'), 2)
        assert.deepEqual(seen, ['a', 'b'])
        seen.length = 0
        assert.equal(bus.emit('x'), 3)
        assert.deepEqual(seen, ['a', 'b', 'new'])
        assert.equal(off(), false)
      },
    },
    {
      id: 'once-reentrancy-and-duplicates',
      requires: [clauses['event-bus'].registration, clauses['event-bus'].snapshot],
      run(m) {
        const bus = m.createBus()
        const seen: unknown[] = []
        bus.on(
          '__proto__',
          () => {
            seen.push('once')
            assert.equal(bus.emit('__proto__', 'nested'), 2)
          },
          { once: true },
        )
        const listener = (...args: unknown[]) => seen.push(args)
        const off = bus.on('__proto__', listener)
        bus.on('__proto__', listener, { once: true })
        // Nested emit consumes the later once registration; outer snapshot skips it.
        assert.equal(bus.emit('__proto__', 'outer', 7), 2)
        assert.deepEqual(seen, ['once', ['nested'], ['nested'], ['outer', 7]])
        assert.equal(off(), true)
        assert.equal(off(), false)
        assert.equal(bus.emit('__proto__'), 0)
        const other = m.createBus()
        assert.equal(other.emit('__proto__'), 0)
        other.on('', listener)
        assert.equal(other.emit('', 0), 1)
      },
    },
    {
      id: 'aggregate-listener-errors',
      requires: [clauses['event-bus'].errors, clauses['event-bus'].snapshot],
      run(m) {
        const bus = m.createBus()
        const nested = new AggregateError(['nested'])
        let notified = 0
        bus.on(
          'x',
          () => {
            throw 0
          },
          { once: true },
        )
        bus.on('x', () => {
          throw nested
        })
        bus.on('x', () => {
          notified++
        })
        assert.throws(
          () => bus.emit('x'),
          (error: unknown) => {
            assert.ok(error instanceof AggregateError)
            assert.deepEqual(error.errors, [0, nested])
            return true
          },
        )
        assert.equal(notified, 1)
        assert.throws(
          () => bus.emit('x'),
          (error: unknown) => {
            assert.ok(error instanceof AggregateError)
            assert.deepEqual(error.errors, [nested])
            return true
          },
        )
        assert.equal(notified, 2)
      },
    },
  ],
  'async-pool': [
    {
      id: 'pool-capacity-and-fifo',
      requires: [clauses['async-pool'].capacity, clauses['async-pool'].fifo],
      async run(m, _random, signal) {
        for (const limit of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])
          assert.throws(() => new m.Pool(limit), RangeError)
        const pool = new m.Pool(1)
        const first = deferred()
        const seen: string[] = []
        const a = pool
          .run(async () => {
            seen.push('a')
            await first.promise
            pool.run(() => seen.push('nested'))
            throw new Error('job')
          })
          .catch(() => 'rejected')
        const b = pool.run(() => {
          seen.push('b')
          return 9
        })
        await until(() => seen.length > 0, signal)
        assert.deepEqual(seen, ['a'])
        first.resolve(undefined)
        assert.equal(await a, 'rejected')
        assert.equal(await b, 9)
        await until(() => seen.includes('nested'), signal)
        assert.deepEqual(seen, ['a', 'b', 'nested'])
        const separate = new m.Pool(1)
        assert.equal(await separate.run(() => 3), 3)
        assert.equal(await pool.run(() => undefined), undefined)
      },
    },
    {
      id: 'queued-and-before-start-abort',
      requires: [
        clauses['async-pool'].capacity,
        clauses['async-pool'].cancellation,
        clauses['async-pool'].fifo,
      ],
      async run(m) {
        const pool = new m.Pool(1)
        const reason = { why: 'cancelled' }
        let called = false
        const pre = new AbortController()
        pre.abort(reason)
        await assert.rejects(
          pool.run(() => {
            called = true
          }, pre.signal),
          (error) => error === reason,
        )
        const immediate = new AbortController()
        const immediateResult = pool
          .run(() => {
            called = true
          }, immediate.signal)
          .catch((error) => error)
        immediate.abort(reason)
        assert.equal(await immediateResult, reason)
        assert.equal(called, false)
        const gate = deferred()
        const active = pool.run(() => gate.promise)
        let started = false
        const queuedAbort = new AbortController()
        let cancelled: unknown
        const queued = pool
          .run(() => {
            started = true
          }, queuedAbort.signal)
          .catch((error) => {
            cancelled = error
            return error
          })
        const after = pool.run(() => 11)
        try {
          queuedAbort.abort(reason)
          await new Promise<void>((resolve) => setImmediate(resolve))
          assert.equal(cancelled, reason)
          assert.equal(await queued, reason)
        } finally {
          gate.resolve(undefined)
        }
        await active
        assert.equal(await after, 11)
        assert.equal(started, false)
      },
    },
    {
      id: 'running-abort-is-ignored',
      requires: [clauses['async-pool'].capacity, clauses['async-pool'].cancellation],
      async run(m, _random, signal) {
        const pool = new m.Pool(1)
        const gate = deferred()
        const controller = new AbortController()
        let started = false
        let nextStarted = false
        const first = pool
          .run(() => {
            started = true
            return gate.promise
          }, controller.signal)
          .catch((error) => error)
        await until(() => started, signal)
        const next = pool.run(() => {
          nextStarted = true
          return 12
        })
        try {
          controller.abort('ignored')
          await new Promise<void>((resolve) => setImmediate(resolve))
          assert.equal(nextStarted, false)
        } finally {
          gate.resolve(11)
        }
        assert.equal(await first, 11)
        assert.equal(await next, 12)
      },
    },
  ],
}

export function assertSpecCoverage(specs: Record<Family, string> = specifications): void {
  for (const family of families) {
    if (!hiddenGroups[family].length) throw new Error(`Missing groups: ${family}`)
    const covered = new Set(hiddenGroups[family].flatMap((group) => [...group.requires]))
    for (const clause of Object.values(clauses[family]))
      if (!covered.has(clause)) throw new Error(`Uncovered clause: ${family}/${clause}`)
    const ids = new Set<string>()
    for (const group of hiddenGroups[family]) {
      if (ids.has(group.id) || !group.requires.length)
        throw new Error(`Invalid assertion group: ${group.id}`)
      ids.add(group.id)
      for (const clause of group.requires)
        if (!specs[family].includes(clause))
          throw new Error(
            `Hidden assertion ${family}/${group.id} lacks an explicit spec clause: ${clause}`,
          )
    }
  }
}

export interface HiddenGroupResult {
  id: string
  clause_ids: string[]
  passed: boolean
  message?: string
}

export const GROUP_TIMEOUT_MS = 4000
class GroupTimeout extends Error {}
class SubjectLoadError extends Error {}

/** Run every independent group; results stay outside the agent's process and context. */
export async function inspectHidden(
  repo: string,
  family: Family,
  seed: number,
  emit?: (event: unknown) => void,
): Promise<HiddenGroupResult[]> {
  assertSpecCoverage()
  const subjectPath = path.join(repo, 'src/subject.ts')
  await access(subjectPath) // Missing grader input is infrastructure failure, not an assertion.
  let m: Subject
  try {
    m = (await import(`${pathToFileURL(subjectPath).href}?seed=${seed}`)) as Subject
  } catch (error) {
    throw new SubjectLoadError('Submitted implementation could not load', { cause: error })
  }
  let state = seed >>> 0
  const random = (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state % n
  }
  const results: HiddenGroupResult[] = []
  for (const group of hiddenGroups[family]) {
    const clause_ids = Object.entries(clauses[family])
      .filter(([, text]) => group.requires.includes(text))
      .map(([id]) => `${family}.${id}`)
    emit?.({ kind: 'group_start', id: group.id, clause_ids })
    let result: HiddenGroupResult = { id: group.id, clause_ids, passed: true }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.resolve().then(() => group.run(m, random, controller.signal)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new GroupTimeout(`Assertion group exceeded ${GROUP_TIMEOUT_MS}ms`)
            controller.abort(error)
            reject(error)
          }, GROUP_TIMEOUT_MS)
        }),
      ])
    } catch (error) {
      // Assertion/deadline failures and exceptions originating in the submitted code
      // are task failures. An unexpected exception in the oracle must not grade it FAIL.
      if (
        error instanceof Error &&
        !(error instanceof assert.AssertionError) &&
        !(error instanceof GroupTimeout) &&
        !error.stack?.includes(subjectPath)
      )
        throw error
      result = {
        ...result,
        passed: false,
        message: (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(
          0,
          800,
        ),
      }
    } finally {
      clearTimeout(timer)
    }
    results.push(result)
    emit?.({ kind: 'group_result', ...result })
  }
  return results
}

export function parseHiddenResults(stdout: string): HiddenGroupResult[] {
  const results: HiddenGroupResult[] = []
  for (const line of stdout.split('\n')) {
    try {
      const value = JSON.parse(line)
      if (
        value.kind === 'group_result' &&
        typeof value.id === 'string' &&
        typeof value.passed === 'boolean' &&
        Array.isArray(value.clause_ids) &&
        value.clause_ids.every((id: unknown) => typeof id === 'string')
      )
        results.push(value as HiddenGroupResult)
    } catch {}
  }
  return results
}

/** Compatibility API used by external probes: any failed group rejects the check. */
export async function hiddenCheck(repo: string, family: Family, seed: number): Promise<void> {
  const results = await inspectHidden(repo, family, seed)
  if (results.some((result) => !result.passed))
    throw new AggregateError(
      results
        .filter((result) => !result.passed)
        .map((result) => new Error(`${result.id}: ${result.message}`)),
      'Hidden contract check failed',
    )
}

if (import.meta.main) {
  const [repo, family, seed] = process.argv.slice(2)
  inspectHidden(repo as string, family as Family, Number(seed), (event) =>
    console.log(JSON.stringify(event)),
  )
    .then((results) => {
      // Submitted code may leave live handles behind after a failed group.
      process.exit(results.some((result) => !result.passed) ? 1 : 0)
    })
    .catch((error) => {
      console.error('Hidden contract check could not complete:', error)
      process.exit(error instanceof SubjectLoadError ? 1 : 2)
    })
}

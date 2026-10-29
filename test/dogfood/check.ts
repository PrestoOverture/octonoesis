import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { type Family, clauses, families, specifications } from './tasks'

type Layer = { start: number; end: number; tag: string }
type Move = { from: string; to: string; amount: unknown }
interface Subject {
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
interface AssertionGroup {
  id: string
  requires: readonly string[]
  run(subject: Subject, random: (n: number) => number): void | Promise<void>
}

/** Every executable assertion belongs to a group linked to verbatim agent-visible clauses. */
export const hiddenGroups: Record<Family, readonly AssertionGroup[]> = {
  'interval-overlay': [
    {
      id: 'overlay-matrix',
      requires: Object.values(clauses['interval-overlay']),
      run(m, random) {
        for (let run = 0; run < 100; run++) {
          const layers = Array.from({ length: 12 }, () => {
            const start = random(30) - 15
            return { start, end: start + random(12), tag: String(random(3)) }
          })
          const before = JSON.stringify(layers)
          const expected: Layer[] = []
          for (let x = -15; x < 27; x++) {
            let tag: string | undefined
            for (const layer of layers) if (layer.start <= x && x < layer.end) tag = layer.tag
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
      async run(m, random) {
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
          // The outer checker process owns the deadline if a loader never starts.
          const started = async (count: number) => {
            while (calls < count) await new Promise<void>((resolve) => setImmediate(resolve))
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
        assert.equal(await retry.get('a'), 9)
      },
    },
  ],
}

export function assertSpecCoverage(specs: Record<Family, string> = specifications): void {
  for (const family of families) {
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

/** Run every independent group; results stay outside the agent's process and context. */
export async function inspectHidden(
  repo: string,
  family: Family,
  seed: number,
  emit?: (event: unknown) => void,
): Promise<HiddenGroupResult[]> {
  assertSpecCoverage()
  const m = (await import(
    `${pathToFileURL(path.join(repo, 'src/subject.ts')).href}?seed=${seed}`
  )) as Subject
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
    try {
      await group.run(m, random)
    } catch (error) {
      result = {
        ...result,
        passed: false,
        message: (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(
          0,
          800,
        ),
      }
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
      if (results.some((result) => !result.passed)) process.exitCode = 1
    })
    .catch(() => {
      console.error('Hidden contract check could not complete')
      process.exitCode = 1
    })
}

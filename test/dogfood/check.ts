import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Family } from './tasks'

/** External oracle. Invoked only AFTER the agent process exits, outside its repository. */
export async function hiddenCheck(repo: string, family: Family, seed: number): Promise<void> {
  const m = await import(`${pathToFileURL(path.join(repo, 'src/subject.ts')).href}?seed=${seed}`)
  let state = seed >>> 0
  const random = (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state % n
  }
  if (family === 'interval-overlay') {
    for (let run = 0; run < 100; run++) {
      const layers = Array.from({ length: 12 }, () => {
        const start = random(30) - 15
        return { start, end: start + random(12), tag: String(random(3)) }
      })
      const before = JSON.stringify(layers)
      const expected: { start: number; end: number; tag: string }[] = []
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
    return
  }
  if (family === 'atomic-transfer') {
    const special = JSON.parse('{"__proto__":5,"constructor":0,"a":10}')
    assert.deepEqual(
      m.transfer(special, [{ from: '__proto__', to: 'constructor', amount: 5 }]),
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
    for (const amount of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0.1,
      Number.MAX_SAFE_INTEGER + 1,
      '1',
      null,
    ])
      assert.throws(() => m.transfer({ a: 3, b: 0 }, [{ from: 'a', to: 'b', amount }]), RangeError)
    assert.throws(() => m.transfer({ a: Number.NaN }, []), RangeError)
    assert.throws(
      () => m.transfer({ a: 1, b: Number.MAX_SAFE_INTEGER }, [{ from: 'a', to: 'b', amount: 1 }]),
      RangeError,
    )
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
      assert.deepEqual(m.transfer(original, moves), { a, b })
      assert.equal(JSON.stringify(original), before)
      const bad = [{ from: 'a', to: 'b', amount: a + 1 }]
      assert.throws(() => m.transfer(original, bad), RangeError)
      assert.equal(JSON.stringify(original), before)
    }
    return
  }
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
    const p = c.get('x')
    const p2 = c.get('x')
    await Promise.resolve()
    assert.equal(calls, 1)
    c.invalidate('x')
    const newer = c.get('x')
    await Promise.resolve()
    assert.equal(calls, 2)
    time += 7 // TTL starts at completion rather than request initiation.
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
}

if (import.meta.main) {
  const [repo, family, seed] = process.argv.slice(2)
  hiddenCheck(repo as string, family as Family, Number(seed))
    .then(() => console.log('PASS'))
    .catch(() => {
      // No source, expected values, or oracle internals enter the agent's context.
      console.error('Hidden contract check failed')
      process.exitCode = 1
    })
}

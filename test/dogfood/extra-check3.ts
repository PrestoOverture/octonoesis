import assert from 'node:assert/strict'
import type { AssertionGroup } from './check'
import { type ExtraFamily3, type Scheduler, extraClauses3 as c } from './extra-tasks3'

const equal: (actual: unknown, expected: unknown) => void = assert.deepEqual

function scheduler() {
  let time = 0
  let serial = 0
  const jobs = new Map<number, { at: number; fn: () => void }>()
  const api: Scheduler = {
    now: () => time,
    set(delay, fn) {
      const id = ++serial
      jobs.set(id, { at: time + delay, fn })
      return id
    },
    clear(handle) {
      jobs.delete(handle as number)
    },
  }
  return {
    api,
    advance(target: number) {
      let budget = 1000
      while (true) {
        const next = [...jobs]
          .filter(([, j]) => j.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!next) break
        assert.ok(--budget > 0, 'scheduler must make progress')
        time = next[1].at
        jobs.delete(next[0])
        next[1].fn()
      }
      time = target
    },
  }
}
export const extraGroups3: Record<ExtraFamily3, AssertionGroup[]> = {
  'money-allocate': [
    {
      id: 'custom-remainder-tie-priority',
      requires: [
        c['money-allocate'].ties,
        c['money-allocate'].remainder,
        c['money-allocate'].split,
      ],
      run(m, random) {
        for (let k = 0; k < 40; k++) {
          const n = 2 + random(7)
          const first = random(n)
          const order = Array.from({ length: n }, (_, i) => (first + i) % n)
          const units = 1 + random(n - 1)
          const expected = Array.from({ length: n }, (_, i) => (order.indexOf(i) < units ? 1 : 0))
          equal(m.allocate(units, Object.freeze(Array(n).fill(1)), Object.freeze(order)), expected)
          equal(
            m.allocate(-units, Array(n).fill(1), order),
            expected.map((x) => (x ? -1 : 0)),
          )
        }
        // Priority breaks only ties, never unequal remainders or output positions.
        equal(m.allocate(2, [1, 3], [1, 0]), [0, 2])
        equal(m.allocate(1, [1, 2], [0, 1]), [0, 1])
        for (const order of [
          [],
          [0],
          [0, 0],
          [0, 2],
          [0, -1],
          [0, 0.5],
          [0, Number.NaN],
          Object.assign(Array(2), { 0: 0 }),
        ])
          for (const total of [0, 2])
            assert.throws(() => m.allocate(total, [1, 1], order), RangeError)
      },
    },
    {
      id: 'exact-signed-remainders',
      requires: Object.values(c['money-allocate']),
      run(m, random) {
        for (let k = 0; k < 80; k++) {
          const total = random(1000) - 500
          const ratios = Array.from({ length: 1 + random(8) }, () => random(10))
          if (!ratios.some(Boolean)) ratios[0] = 1
          // Independent unit assignment: compare residual entitlement after each floor.
          const sum = ratios.reduce((a, b) => a + b, 0)
          const out = ratios.map((r) => Math.floor((Math.abs(total) * r) / sum))
          const order = ratios
            .map((r, i) => ({ i, remainder: (Math.abs(total) * r) % sum }))
            .sort((a, b) => b.remainder - a.remainder || a.i - b.i)
          const left = Math.abs(total) - out.reduce((a, b) => a + b, 0)
          for (const x of order.slice(0, left)) out[x.i] = (out[x.i] as number) + 1
          equal(
            m.allocate(total, Object.freeze(ratios)),
            out.map((n) => (n === 0 ? 0 : total < 0 ? -n : n)),
          )
        }
        const M = Number.MAX_SAFE_INTEGER
        equal(m.allocate(M, [M, M]), [4503599627370496, 4503599627370495])
        equal(m.allocate(-1, [1, 1, 1]), [-1, 0, 0])
        for (const ratios of [
          [],
          [0, 0],
          [-1, 2],
          [Number.NaN],
          [Number.POSITIVE_INFINITY],
          [0.5],
          [M + 1],
        ])
          assert.throws(() => m.allocate(1, ratios), RangeError)
        for (const t of [Number.NaN, Number.POSITIVE_INFINITY, 0.1, M + 1])
          assert.throws(() => m.allocate(t, [1]), RangeError)
      },
    },
  ],
  'token-bucket': [
    {
      id: 'fractional-high-water-refill',
      requires: Object.values(c['token-bucket']),
      run(m, random) {
        for (let i = 0; i < 30; i++) {
          let t = random(100)
          const start = t
          const b = new m.TokenBucket(3, 2, () => t)
          assert.equal(b.take(3), true)
          t -= 5
          assert.equal(b.take(), false)
          t = start
          assert.equal(b.take(), false)
          t += 0.125
          assert.equal(b.take(0.25), true)
          assert.equal(b.take(0.25), false)
          t += 100
          assert.equal(b.take(4), false)
          assert.equal(b.take(3), true)
          assert.equal(b.take(), false)
        }
        for (const x of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
          assert.throws(() => new m.TokenBucket(x, 1, () => 0), RangeError)
          assert.throws(() => new m.TokenBucket(1, x, () => 0), RangeError)
          assert.throws(() => new m.TokenBucket(1, 1, () => 0).take(x), RangeError)
        }
      },
    },
  ],
  'debounce-scheduler': [
    {
      id: 'quiet-leading-maxwait',
      requires: [c['debounce-scheduler'].api, c['debounce-scheduler'].timing],
      run(m, random) {
        const s = scheduler()
        const seen: unknown[][] = []
        const d = m.debounce(
          function (this: unknown, ...a: unknown[]) {
            seen.push([s.api.now(), this, ...a])
            return a[0]
          },
          5,
          s.api,
          { leading: true, maxWait: 12 },
        )
        const receiver = { d }
        const tag = random(10000)
        assert.equal(receiver.d(tag), tag)
        s.advance(4)
        receiver.d(tag + 1)
        s.advance(8)
        receiver.d(tag + 2)
        s.advance(11)
        assert.equal(seen.length, 1)
        s.advance(12)
        equal(seen, [
          [0, receiver, tag],
          [12, receiver, tag + 2],
        ])
        s.advance(20)
        receiver.d(tag + 3)
        s.advance(25)
        assert.equal(seen.length, 3)
        const plain = m.debounce((x) => seen.push([s.api.now(), x]), 3, s.api)
        plain(tag)
        s.advance(27)
        plain(tag + 1)
        s.advance(29)
        assert.equal(seen.length, 3)
        s.advance(30)
        equal(seen.at(-1), [30, tag + 1])
        for (const wait of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
          assert.throws(() => m.debounce(() => {}, wait, s.api), RangeError)
        for (const maxWait of [1, Number.NaN, Number.POSITIVE_INFINITY])
          assert.throws(() => m.debounce(() => {}, 3, s.api, { maxWait }), RangeError)
      },
    },
    {
      id: 'flush-cancel-reentrant-ownership',
      requires: [
        c['debounce-scheduler'].api,
        c['debounce-scheduler'].timing,
        c['debounce-scheduler'].control,
      ],
      run(m, random) {
        const s = scheduler()
        const seen: unknown[] = []
        const tag = random(1000)
        const d: ReturnType<typeof m.debounce> = m.debounce(
          (x) => {
            seen.push(x)
            if (x === tag) d(tag + 1)
            return x
          },
          4,
          s.api,
        )
        assert.equal(d(tag), undefined)
        assert.equal(d.flush(), tag)
        s.advance(4)
        equal(seen, [tag, tag + 1])
        assert.equal(d.flush(), tag + 1)
        d('cancel')
        d.cancel()
        s.advance(20)
        assert.equal(d.flush(), tag + 1)
        const off = m.debounce((x) => seen.push(x), 2, s.api, {
          leading: true,
          trailing: false,
          maxWait: 4,
        })
        off('once')
        off('ignored')
        off.flush()
        s.advance(30)
        equal(seen, [tag, tag + 1, 'once'])
        // A leading callback may close its own burst and create another one.
        const leading: ReturnType<typeof m.debounce> = m.debounce(
          (x) => {
            seen.push(x)
            if (x === 'outer') {
              leading.cancel()
              leading('inner')
            }
          },
          2,
          s.api,
          { leading: true },
        )
        leading('outer')
        s.advance(32)
        equal(seen.slice(-2), ['outer', 'inner'])
      },
    },
  ],
  'rational-math': [
    {
      id: 'canonical-bigint-arithmetic-and-parser',
      requires: Object.values(c['rational-math']),
      run(m, random) {
        for (let i = 0; i < 80; i++) {
          const a = BigInt(random(1000) - 500)
          const b = BigInt(1 + random(999))
          const x = m.rational(a, -b)
          assert.ok(x.d > 0n)
          assert.equal(x.n * b, -a * x.d)
          equal(m.parse(`${a}/-${b}`), x)
          equal(m.add(Object.freeze(x), Object.freeze({ n: -x.n, d: x.d })), {
            n: 0n,
            d: 1n,
          })
          assert.equal(m.compare(x, { n: x.n + 1n, d: x.d }), -1)
          assert.equal(m.compare(x, x), 0)
          assert.equal(m.compare({ n: x.n + 1n, d: x.d }, x), 1)
        }
        equal(m.rational(12n, -18n), { n: -2n, d: 3n })
        assert.equal(m.compare({ n: 1n, d: -2n }, { n: 1n, d: 3n }), -1)
        assert.throws(() => m.compare({ n: 1n, d: 0n }, { n: 1n, d: 2n }), RangeError)
        assert.throws(() => m.add({ n: 1n, d: 0n }, { n: 1n, d: 2n }), RangeError)
        equal(m.add({ n: 1n, d: 6n }, { n: 1n, d: 3n }), { n: 1n, d: 2n })
        const huge = 10n ** 100n
        equal(m.parse(`${huge * 3n}/+${huge * 6n}`), { n: 1n, d: 2n })
        assert.equal(m.compare({ n: huge, d: huge + 1n }, { n: huge + 1n, d: huge + 2n }), -1)
        equal(m.rational(0n, -100n), { n: 0n, d: 1n })
        for (const text of [
          '1',
          ' 1/2',
          '1/2\n',
          '1 /2',
          '1/2/3',
          '1.0/2',
          '/2',
          '1/',
          '0x1/2',
          '--1/2',
        ])
          assert.throws(() => m.parse(text), SyntaxError)
        assert.throws(() => m.parse('1/-0'), RangeError)
        assert.throws(() => m.rational(0n, 0n), RangeError)
      },
    },
  ],
  'stable-heap': [
    {
      id: 'seeded-handle-lifecycle-and-stable-updates',
      requires: Object.values(c['stable-heap']),
      run(m, random) {
        const h = new m.StableHeap()
        const other = new m.StableHeap()
        const model: {
          handle: unknown
          value: unknown
          priority: number
          seq: number
          active: boolean
        }[] = []
        for (let i = 0; i < 200; i++) {
          const active = model.filter((x) => x.active)
          const action = random(4)
          if (!active.length || action === 0) {
            const value = i % 7 === 0 ? undefined : i
            const priority = random(5) - 2
            const handle = h.push(value, priority)
            assert.ok(!model.some((x) => x.handle === handle))
            model.push({ handle, value, priority, seq: i, active: true })
          } else if (action === 1) {
            const e = active[random(active.length)] as (typeof model)[number]
            const p = random(5) - 2
            assert.equal(h.update(e.handle, p), true)
            e.priority = p
          } else if (action === 2) {
            const e = active[random(active.length)] as (typeof model)[number]
            assert.equal(h.remove(e.handle), true)
            e.active = false
          } else {
            const e = active.sort(
              (a, b) => a.priority - b.priority || a.seq - b.seq,
            )[0] as (typeof model)[number]
            assert.equal(h.pop(), e.value)
            e.active = false
          }
          const expected = model
            .filter((x) => x.active)
            .sort((a, b) => a.priority - b.priority || a.seq - b.seq)
          assert.equal(h.size, expected.length)
          assert.equal(h.peek(), expected[0]?.value)
          for (const e of model.filter((x) => !x.active)) {
            assert.equal(h.remove(e.handle), false)
            assert.equal(h.update(e.handle, 0), false)
          }
        }
        const a = h.push('first', -100)
        const b = h.push('second', -100)
        h.update(a, -100)
        assert.equal(h.pop(), 'first')
        assert.equal(h.pop(), 'second')
        assert.equal(h.update(other.push('foreign', 0), 1), false)
        assert.equal(other.remove(b), false)
        for (const p of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
          assert.throws(() => h.push(1, p), RangeError)
          assert.throws(() => h.update({}, p), RangeError)
        }
        const empty = new m.StableHeap()
        assert.equal(empty.pop(), undefined)
        assert.equal(empty.peek(), undefined)
      },
    },
  ],
}

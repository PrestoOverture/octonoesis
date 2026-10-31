import assert from 'node:assert/strict'
import type { AssertionGroup } from './check'
import { type ExtraFamily, type Json, extraClauses as c } from './extra-tasks'

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const plain = (value: Json): Json => JSON.parse(JSON.stringify(value))
function independentCopies(result: Json, ...inputs: Json[]) {
  const objects = (x: Json): object[] =>
    x && typeof x === 'object' ? [x, ...Object.values(x).flatMap(objects)] : []
  const originals = new Set(inputs.flatMap(objects))
  for (const value of objects(result)) assert.equal(originals.has(value), false)
}
export const extraGroups: Record<ExtraFamily, AssertionGroup[]> = {
  'csv-records': [
    {
      id: 'quoted-record-roundtrip',
      requires: [c['csv-records'].format, c['csv-records'].edges],
      run(m, random) {
        for (let i = 0; i < 50; i++) {
          const values = [
            '',
            'a,b',
            'a"b',
            'a\nb',
            'a\r\nb',
            ' spaces ',
            `v${random(100000)}`,
            '__proto__',
          ]
          const rows = Array.from({ length: 1 + random(5) }, () =>
            Array.from({ length: 1 + random(5) }, () => values[random(values.length)] as string),
          )
          // Encoder is independent of the parser, including quoted empty rows.
          const text = rows
            .map((row) => row.map((field) => `"${field.replaceAll('"', '""')}"`).join(','))
            .join(i % 2 ? '\r\n' : '\n')
          assert.deepEqual(m.parseCSV(text + (i % 3 === 0 ? '\r\n' : '')), rows)
        }
        for (const [text, rows] of [
          ['', []],
          [',', [['', '']]],
          ['\n', [['']]],
          ['a\n\n', [['a'], ['']]],
          ['a,', [['a', '']]],
        ] as const)
          assert.deepEqual(m.parseCSV(text), rows)
      },
    },
    {
      id: 'malformed-quoting',
      requires: [c['csv-records'].format],
      run(m) {
        for (const text of ['"', 'a"b', '"x"z', '"x" ', 'a\rb', 'a\r', '"a""'])
          assert.throws(() => m.parseCSV(text), SyntaxError)
        assert.deepEqual(m.parseCSV(' a ,b '), [[' a ', 'b ']])
      },
    },
  ],
  'dependency-plan': [
    {
      id: 'target-prerequisite-closure',
      requires: [
        c['dependency-plan'].targets,
        c['dependency-plan'].graph,
        c['dependency-plan'].errors,
      ],
      run(m, random) {
        for (let i = 0; i < 30; i++) {
          const root = `root${random(100000)}`
          const nodes = freeze(['z', root, 'a', '', '__proto__', 'unrelated'])
          const edges = freeze([
            [root, 'z'],
            ['a', root],
            ['', 'a'],
            ['__proto__', root],
            [root, 'z'],
          ])
          const targets = freeze(['z', 'z'])
          assert.deepEqual(m.plan(nodes, edges, targets), ['', '__proto__', 'a', root, 'z'])
          assert.deepEqual(m.plan(nodes, edges, freeze([])), [])
          assert.deepEqual(targets, ['z', 'z'])
          assert.throws(() => m.plan(nodes, edges, ['missing']), RangeError)
        }
        for (const targets of [[], ['a']]) {
          assert.throws(
            () =>
              m.plan(
                ['a', 'b', 'c'],
                [
                  ['b', 'c'],
                  ['c', 'b'],
                ],
                targets,
              ),
            RangeError,
          )
          assert.throws(() => m.plan(['a'], [['missing', 'a']], targets), RangeError)
        }
      },
    },
    {
      id: 'lexical-dag-and-duplicates',
      requires: [c['dependency-plan'].graph, c['dependency-plan'].errors],
      run(m, random) {
        for (let i = 0; i < 40; i++) {
          const nodes = ['', '__proto__', 'constructor', 'b', `v${random(10000)}`, 'a']
          const edges: string[][] = []
          for (let a = 0; a < nodes.length; a++)
            for (let b = a + 1; b < nodes.length; b++)
              if (random(3) === 0) edges.push([nodes[a] as string, nodes[b] as string])
          const remaining = new Set(nodes)
          const expected: string[] = []
          while (remaining.size) {
            const ready = [...remaining]
              .filter((n) => !edges.some(([a, b]) => b === n && remaining.has(a as string)))
              .sort()[0] as string
            expected.push(ready)
            remaining.delete(ready)
          }
          const input = freeze([...nodes].reverse())
          const links = freeze([...edges, ...edges].map((e) => [...e]))
          assert.deepEqual(m.plan(input, links), expected)
          assert.deepEqual(input, [...nodes].reverse())
        }
      },
    },
    {
      id: 'cycles-and-unknowns',
      requires: [c['dependency-plan'].graph, c['dependency-plan'].errors],
      run(m) {
        assert.deepEqual(m.plan([], []), [])
        for (const edges of [
          [['a', 'a']],
          [
            ['a', 'b'],
            ['b', 'a'],
          ],
          [['a', 'missing']],
          [['missing', 'a']],
        ])
          assert.throws(() => m.plan(['a', 'b'], edges), RangeError)
      },
    },
  ],
  'merge-patch': [
    {
      id: 'recursive-replacement-and-deletion',
      requires: [c['merge-patch'].patch, c['merge-patch'].ownership],
      run(m, random) {
        for (let i = 0; i < 40; i++) {
          const n = random(100000)
          const target = freeze({ a: { x: n, y: [{ z: n }] }, b: 3, keep: { n } })
          const patch = freeze({ a: { x: null, y: [n] }, b: { child: n }, missing: null })
          const result = m.mergePatch(target, patch)
          assert.deepEqual(plain(result), { a: { y: [n] }, b: { child: n }, keep: { n } })
          independentCopies(result, target, patch)
        }
        for (const value of [null, 3, true, 'x', [{ x: 1 }]] as Json[]) {
          const result = m.mergePatch({ a: 1 }, value)
          assert.deepEqual(plain(result), value)
          independentCopies(result, value)
        }
        assert.deepEqual(plain(m.mergePatch([1, 2], { a: 1 })), { a: 1 })
      },
    },
    {
      id: 'prototype-data-and-unmodified-subtrees',
      requires: [c['merge-patch'].patch, c['merge-patch'].ownership],
      run(m) {
        const target = freeze(
          JSON.parse('{"__proto__":{"x":1},"constructor":2,"untouched":[{"a":1}]}'),
        )
        const patch = freeze(JSON.parse('{"__proto__":{"y":2},"constructor":null,"toString":3}'))
        const result = m.mergePatch(target, patch) as Record<string, Json>
        assert.equal(Object.hasOwn(result, '__proto__'), true)
        assert.deepEqual(plain(result.__proto__ as Json), { x: 1, y: 2 })
        assert.equal(Object.hasOwn(result, 'constructor'), false)
        assert.equal(Object.hasOwn(result, 'toString'), true)
        assert.equal(result.toString, 3)
        independentCopies(result, target, patch)
        assert.equal(Object.hasOwn(target, 'constructor'), true)
      },
    },
  ],
  'civil-date': [
    {
      id: 'gregorian-boundaries-and-seeded-offsets',
      requires: [c['civil-date'].calendar, c['civil-date'].errors],
      run(m, random) {
        // Independent calendar oracle steps month lengths, without Date normalization.
        const leap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
        const length = (y: number, month: number) =>
          [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number
        const format = (y: number, month: number, d: number) =>
          `${String(y).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        for (let i = 0; i < 100; i++) {
          let y = [1, 4, 99, 100, 400, 1900, 2000, 2024, 9998][random(9)] as number
          let month = 1 + random(12)
          let d = 1 + random(length(y, month))
          const start = format(y, month, d)
          const delta = random(61) - 30
          if (y === 1 && month === 1 && d + delta < 1) continue
          for (let k = 0; k < Math.abs(delta); k++) {
            if (delta > 0) {
              d++
              if (d > length(y, month)) {
                d = 1
                month++
                if (month > 12) {
                  month = 1
                  y++
                }
              }
            } else {
              d--
              if (d < 1) {
                month--
                if (month < 1) {
                  month = 12
                  y--
                }
                d = length(y, month)
              }
            }
          }
          assert.equal(m.addDays(start, delta), format(y, month, d))
        }
        assert.equal(m.addDays('2000-03-01', -1), '2000-02-29')
        assert.equal(m.addDays('1900-03-01', -1), '1900-02-28')
        assert.equal(m.addDays('0001-01-01', 0), '0001-01-01')
        assert.equal(m.addDays('9999-12-31', 0), '9999-12-31')
      },
    },
    {
      id: 'reject-normalization-and-range',
      requires: [c['civil-date'].calendar, c['civil-date'].errors],
      run(m) {
        for (const date of [
          '0000-01-01',
          '10000-01-01',
          '2024-2-01',
          '2024-02-30',
          '1900-02-29',
          '2024-00-01',
          '2024-13-01',
          '2024-01-00',
          '2024-04-31',
          '2024-01-01Z',
          'no',
        ])
          assert.throws(() => m.addDays(date, 0), RangeError)
        for (const delta of [
          0.5,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          Number.MAX_SAFE_INTEGER + 1,
        ])
          assert.throws(() => m.addDays('2024-01-01', delta), RangeError)
        assert.throws(() => m.addDays('0001-01-01', -1), RangeError)
        assert.throws(() => m.addDays('9999-12-31', 1), RangeError)
        assert.throws(() => m.addDays('2024-01-01', Number.MAX_SAFE_INTEGER), RangeError)
      },
    },
  ],
  'ranked-vote': [
    {
      id: 'transfers-exhaustion-and-ties',
      requires: [c['ranked-vote'].election, c['ranked-vote'].elimination],
      run(m, random) {
        function oracle(names: string[], ballots: string[][]): string | null {
          const votes = names.map(
            (n) => ballots.filter((b) => b.find((x) => names.includes(x)) === n).length,
          )
          const total = votes.reduce((a, b) => a + b, 0)
          if (!total) return null
          const winner = names.find((_, i) => (votes[i] as number) > total / 2)
          if (winner !== undefined) return winner
          const min = Math.min(...votes)
          const loser = names
            .filter((_, i) => votes[i] === min)
            .sort()
            .at(-1)
          return oracle(
            names.filter((n) => n !== loser),
            ballots,
          )
        }
        for (let i = 0; i < 80; i++) {
          const names = ['', 'a', 'z', '__proto__', 'constructor', `v${random(10000)}`]
          const choices = [...names, 'unknown']
          const ballots = Array.from({ length: random(20) }, () =>
            Array.from({ length: random(9) }, () => choices[random(choices.length)] as string),
          )
          const expected = oracle(names, ballots)
          assert.equal(m.elect(freeze([...names]), freeze(ballots)), expected)
        }
        assert.equal(m.elect(['a', 'z'], [['a'], ['z']]), 'a')
        assert.equal(m.elect(['a', 'b', 'z'], [['a'], ['b'], ['z', 'b']]), 'b')
        assert.equal(m.elect([''], [['unknown', '', '']]), '')
        assert.equal(m.elect([], []), null)
        assert.equal(m.elect(['a'], [['unknown'], []]), null)
      },
    },
  ],
}

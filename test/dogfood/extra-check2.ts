import assert from 'node:assert/strict'
import type { AssertionGroup } from './check'
import { type ExtraFamily2, extraClauses2 as c } from './extra-tasks2'

const freeze = <T>(x: T): T => {
  if (x && typeof x === 'object') {
    for (const v of Object.values(x)) freeze(v)
    Object.freeze(x)
  }
  return x
}
function copies(result: unknown, ...inputs: unknown[]) {
  const objects = (x: unknown): object[] =>
    x && typeof x === 'object' ? [x, ...Object.values(x).flatMap(objects)] : []
  const originals = new Set(inputs.flatMap(objects))
  for (const x of objects(result)) assert.equal(originals.has(x), false)
}
export const extraGroups2: Record<ExtraFamily2, AssertionGroup[]> = {
  'ini-config': [
    {
      id: 'ini-sections-quotes-and-own-keys',
      requires: [c['ini-config'].syntax, c['ini-config'].values],
      run(m, random) {
        for (let i = 0; i < 40; i++) {
          const n = String(random(100000))
          const text = `# ignored\r\nroot = ${n} ; note\r\n[ __proto__ ]\r\nconstructor = "a;#=b" # tail\r\nx=old\r\n[other]\r\nx=other\r\n[__proto__]\r\nx=${n}\r\nescape="\\n\\r\\t\\\"\\\\"`
          assert.deepEqual(
            m.parseINI(text),
            JSON.parse(
              JSON.stringify({
                '': { root: n },
                ...Object.fromEntries([
                  ['__proto__', { constructor: 'a;#=b', x: n, escape: '\n\r\t"\\' }],
                ]),
                other: { x: 'other' },
              }),
            ),
          )
          assert.deepEqual(m.parseINI(`x=${n}=tail\nx=last\n[empty]`), {
            '': { x: 'last' },
            empty: {},
          })
        }
        assert.deepEqual(m.parseINI(''), {})
        assert.deepEqual(m.parseINI('a=\nb="  x  "'), { '': { a: '', b: '  x  ' } })
      },
    },
    {
      id: 'ini-malformed',
      requires: [c['ini-config'].syntax, c['ini-config'].values],
      run(m) {
        for (const s of [
          '[]',
          '[ ]',
          '[a',
          '[a]tail',
          'no equals',
          '=x',
          'x="unclosed',
          'x="x" junk',
          'x="\\q"',
          'x="\\',
        ])
          assert.throws(() => m.parseINI(s), SyntaxError)
      },
    },
  ],
  'utf8-codec': [
    {
      id: 'utf8-strip-only-first-bom',
      requires: [c['utf8-codec'].bom, c['utf8-codec'].errors],
      run(m, random) {
        const bom = [239, 187, 191]
        for (let i = 0; i < 30; i++) {
          const ascii = 32 + random(95)
          const bytes = freeze([...bom, ...bom, ascii, ...bom])
          assert.deepEqual(m.decodeUTF8(bytes), [0xfeff, 0xfeff, ascii, 0xfeff])
          assert.deepEqual(m.decodeUTF8(bytes, { stripBOM: true }), [0xfeff, ascii, 0xfeff])
          assert.deepEqual(m.decodeUTF8(freeze([ascii, ...bom]), { stripBOM: true }), [
            ascii,
            0xfeff,
          ])
        }
        assert.deepEqual(m.decodeUTF8([], { stripBOM: true }), [])
        assert.deepEqual(m.decodeUTF8(bom, { stripBOM: true }), [])
        assert.throws(() => m.decodeUTF8([...bom, 224, 128, 128], { stripBOM: true }), RangeError)
      },
    },
    {
      id: 'utf8-independent-scalar-encoding',
      requires: [c['utf8-codec'].scalar, c['utf8-codec'].errors],
      run(m, random) {
        const points = [0, 127, 128, 2047, 2048, 0xd7ff, 0xe000, 65535, 65536, 0x10ffff]
        for (let i = 0; i < 100; i++) {
          const p = random(0x110000)
          if (p < 0xd800 || p > 0xdfff) points.push(p)
        }
        // Platform encoder is independent of the arithmetic reference implementation.
        const bytes = [...new TextEncoder().encode(String.fromCodePoint(...points))]
        assert.deepEqual(m.encodeUTF8(freeze(points)), bytes)
        assert.deepEqual(m.decodeUTF8(freeze(bytes)), points)
        assert.deepEqual(m.encodeUTF8([]), [])
        assert.deepEqual(m.decodeUTF8([]), [])
      },
    },
    {
      id: 'utf8-reject-noncanonical-and-invalid',
      requires: [c['utf8-codec'].scalar, c['utf8-codec'].errors],
      run(m) {
        for (const p of [-1, 0xd800, 0xdfff, 0x110000, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
          assert.throws(() => m.encodeUTF8([p]), RangeError)
        for (const b of [
          [-1],
          [256],
          [1.5],
          [Number.NaN],
          [Number.POSITIVE_INFINITY],
          [128],
          [192, 128],
          [193, 191],
          [224, 128, 128],
          [240, 128, 128, 128],
          [237, 160, 128],
          [237, 191, 191],
          [244, 144, 128, 128],
          [245, 128, 128, 128],
          [255],
          [194],
          [226, 130],
          [240, 159, 152],
          [226, 65, 128],
          [240, 159, 255, 128],
        ])
          assert.throws(() => m.decodeUTF8(b), RangeError)
      },
    },
  ],
  'semver-range': [
    {
      id: 'semver-precedence-and-identifiers',
      requires: [c['semver-range'].precedence],
      run(m, random) {
        const ordered = ['alpha', 'alpha.1', 'alpha.beta', 'beta', 'beta.2', 'beta.11', 'rc.1', '']
        for (let k = 0; k < 20; k++) {
          const core = `${random(20)}.${random(20)}.${random(20)}`
          for (let i = 0; i < ordered.length; i++)
            for (let j = 0; j < ordered.length; j++) {
              const a = core + (ordered[i] ? `-${ordered[i]}` : '')
              const b = core + (ordered[j] ? `-${ordered[j]}` : '')
              assert.equal(m.compareVersions(`${a}+build.01`, b), Math.sign(i - j))
            }
        }
        assert.equal(
          m.compareVersions('1.0.0-99999999999999999999', '1.0.0-100000000000000000000'),
          -1,
        )
        assert.equal(m.compareVersions('2.0.0', '1.99.99'), 1)
        for (const s of [
          '1',
          '1.2',
          '01.2.3',
          '1.02.3',
          '1.2.03',
          '1.2.3-01',
          '1.2.3-',
          '1.2.3+a..b',
          'v1.2.3',
          '1.2.3\n',
          '1.2.3-ä',
          '9007199254740992.0.0',
        ])
          assert.throws(() => m.compareVersions(s, '1.0.0'), RangeError)
      },
    },
    {
      id: 'semver-range-bounds-prerelease-admission',
      requires: [c['semver-range'].precedence, c['semver-range'].ranges],
      run(m, random) {
        for (let i = 0; i < 40; i++) {
          const n = 1 + random(20)
          for (const [range, yes, no] of [
            [`^${n}.2.3`, `${n}.9.0`, `${n + 1}.0.0`],
            [`~${n}.2.3`, `${n}.2.99`, `${n}.3.0`],
            [`^0.${n}.3`, `0.${n}.99`, `0.${n + 1}.0`],
            [`^0.0.${n}`, `0.0.${n}`, `0.0.${n + 1}`],
          ]) {
            assert.equal(m.satisfies(yes as string, range as string), true)
            assert.equal(m.satisfies(no as string, range as string), false)
          }
          assert.equal(m.satisfies(`${n}.3.0-beta.2`, `>=${n}.2.0 <${n + 1}.0.0`), false)
          assert.equal(m.satisfies(`${n}.2.0-beta.2`, `>=${n}.2.0-beta.1 <${n}.3.0`), true)
          assert.equal(m.satisfies(`${n}.3.0-beta.2`, `>=${n}.2.0-beta.1 <${n + 1}.0.0`), false)
          assert.equal(m.satisfies(`${n}.2.3+abc`, `${n}.2.3`), true)
        }
        for (const [range, expected] of [
          ['>1.2.3', false],
          ['>=1.2.3', true],
          ['<1.2.3', false],
          ['<=1.2.3', true],
          ['=1.2.3', true],
          ['>=1.0.0 <2.0.0', true],
        ])
          assert.equal(m.satisfies('1.2.3', range as string), expected)
        for (const range of [
          '',
          '*',
          '1.2',
          '^1.2',
          '>= 1.2.3',
          '1.0.0 || 2.0.0',
          '<0.0.0 garbage',
        ])
          assert.throws(() => m.satisfies('1.2.3', range), RangeError)
        assert.throws(() => m.satisfies('bad', '1.2.3'), RangeError)
      },
    },
  ],
  'query-string': [
    {
      id: 'query-decoding-repeats-and-own-properties',
      requires: [c['query-string'].parse],
      run(m, random) {
        for (let i = 0; i < 50; i++) {
          const n = String(random(100000))
          assert.deepEqual(
            m.parseQuery(
              `?a=${n}&a=a+b&a=%2B&__proto__=one&constructor=two&toString=three&&=empty&flag&x=a=b`,
            ),
            JSON.parse(
              `{"a":["${n}","a b","+"],"__proto__":["one"],"constructor":["two"],"toString":["three"],"":["empty"],"flag":[""],"x":["a=b"]}`,
            ),
          )
        }
        assert.deepEqual(m.parseQuery('?&&'), {})
        assert.deepEqual(m.parseQuery('%E4%B8%AD=%F0%9F%98%80'), { 中: ['😀'] })
        for (const s of [
          'a=%',
          '%=x',
          'a=%GG',
          'a=%C0%AF',
          'a=%ED%A0%80',
          'a=%F4%90%80%80',
          'a=%E2%82',
        ])
          assert.throws(() => m.parseQuery(s), URIError)
      },
    },
    {
      id: 'query-encoding-and-seeded-roundtrip',
      requires: [c['query-string'].parse, c['query-string'].stringify],
      run(m, random) {
        for (let i = 0; i < 50; i++) {
          const input = freeze(
            Object.fromEntries([
              ['__proto__', ['a+b', 'a b']],
              ['constructor', ['&=?#']],
              ['', ['']],
              ['中', [`😀${random(100000)}`]],
              ['skip', []],
            ]),
          )
          const expected = Object.entries(input)
            .flatMap(([k, vs]) =>
              vs.map((v) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`),
            )
            .join('&')
          assert.equal(m.stringifyQuery(input), expected)
          assert.deepEqual(
            m.parseQuery(expected),
            Object.fromEntries(Object.entries(input).filter(([, vs]) => vs.length)),
          )
        }
        const input = Object.assign(Object.create({ inherited: ['no'] }), { own: ['yes'] })
        assert.equal(m.stringifyQuery(input), 'own=yes')
      },
    },
  ],
  'json-pointer': [
    {
      id: 'pointer-token-escapes-and-seeded-paths',
      requires: [c['json-pointer'].tokens, c['json-pointer'].arrays],
      run(m, random) {
        for (let i = 0; i < 50; i++) {
          const n = random(100000)
          const key = `/~01/${n}`
          const doc = freeze(
            Object.fromEntries([
              [key, { '~1': n, '': [1, 2] }],
              ['__proto__', { constructor: n }],
            ]),
          )
          // Encode a path, independently of decoding in the implementation.
          const path = `/${[key, '~1'].map((x) => x.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`
          assert.equal(m.getPointer(doc, path), n)
          assert.equal(m.getPointer(doc, '/__proto__/constructor'), n)
          assert.equal(m.getPointer(doc, ''), doc)
          const value = freeze({ nested: [n] })
          const out = m.setPointer(doc, path, value)
          assert.deepEqual(m.getPointer(out, path), value)
          copies(out, doc, value)
          assert.equal(m.getPointer(doc, path), n)
          const root = m.setPointer(doc, '', value)
          assert.deepEqual(root, value)
          copies(root, doc, value)
        }
      },
    },
    {
      id: 'pointer-array-append-errors-and-copying',
      requires: [c['json-pointer'].tokens, c['json-pointer'].arrays],
      run(m) {
        const doc = freeze({ a: [{ x: 1 }, 2], keep: { x: 3 } })
        for (const token of ['-', '2']) {
          const out = m.setPointer(doc, `/a/${token}`, { n: 4 })
          assert.deepEqual(out, { a: [{ x: 1 }, 2, { n: 4 }], keep: { x: 3 } })
          copies(out, doc)
        }
        assert.deepEqual(m.setPointer(doc, '/a/0', 9), { a: [9, 2], keep: { x: 3 } })
        assert.deepEqual(
          m.setPointer({}, '/__proto__', { x: 1 }),
          JSON.parse('{"__proto__":{"x":1}}'),
        )
        assert.deepEqual(m.setPointer({ '': 1 }, '/', 2), { '': 2 })
        for (const p of [
          'bad',
          '/~',
          '/~2',
          '/a/-',
          '/a/02',
          '/a/+1',
          '/a/-1',
          '/a/2',
          '/a/9',
          '/a/1/x',
          '/missing',
          '/toString',
        ])
          assert.throws(() => m.getPointer(doc, p), RangeError)
        for (const p of [
          'bad',
          '/~3',
          '/a/-/x',
          '/a/01',
          '/a/3',
          '/a/1/x',
          '/missing/x',
          '/constructor/x',
        ])
          assert.throws(() => m.setPointer(doc, p, 0), RangeError)
        assert.throws(() => m.setPointer(1, '/x', 0), RangeError)
        assert.deepEqual(doc, { a: [{ x: 1 }, 2], keep: { x: 3 } })
      },
    },
  ],
}

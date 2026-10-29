// @ts-nocheck -- standalone eval fixture
import { expect, test } from 'bun:test'
import * as api from './src/metrics'
import { readdirSync, readFileSync } from 'node:fs'
test('split modules and preserve old public entry',()=>{
 const files=readdirSync('src').filter(f=>f.endsWith('.ts') && f!=='metrics.ts')
 expect(files.length).toBeGreaterThanOrEqual(3)
 expect(readFileSync('src/metrics.ts','utf8').split('\n').length).toBeLessThan(30)
 expect(Object.keys(api).sort()).toEqual(Array.from({length:20},(_,i)=>['validate'+i,'format'+i,'parse'+i]).flat().sort())
 for(let i=0;i<20;i++) {
  expect(api['validate'+i](i)).toBe(i)
  expect(api['format'+i](i+0.25)).toBe(`metric${i}=${(i+0.25).toFixed(2)}`)
  expect(api['parse'+i](`metric${i}=${i+1}`)).toBe(i+1)
  for(const value of [NaN,Infinity,-Infinity]) expect(()=>api['validate'+i](value)).toThrow(new TypeError(`metric${i}: expected finite number`))
  expect(()=>api['validate'+i](i-1)).toThrow(new RangeError(`metric${i}: below minimum`))
  expect(()=>api['parse'+i]('bad')).toThrow(new Error(`metric${i}: invalid prefix`))
  expect(()=>api['parse'+i](`metric${i}=bad`)).toThrow(new TypeError(`metric${i}: expected finite number`))
 }
})

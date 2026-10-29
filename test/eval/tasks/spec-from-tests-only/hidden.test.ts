// @ts-nocheck -- standalone eval fixture
import { expect, test } from 'bun:test'
import { coalesce } from './src/ranges'
test('implied edge cases',()=>{
 expect(coalesce([])).toEqual([])
 expect(coalesce([[5,5],[-3,0],[0,2],[1,1],[9,10],[9,10]])).toEqual([[-3,2],[5,5],[9,10]])
 const input=Object.freeze([Object.freeze([3,4]),Object.freeze([1,3])]); const output=coalesce(input)
 expect(output).toEqual([[1,4]]); output[0][0]=99; expect(input[1][0]).toBe(1)
 for(const r of [[[2,1]],[[0,Infinity]],[[NaN,2]],[[0,1.5]],[[0,Number.MAX_SAFE_INTEGER+1]]]) expect(()=>coalesce(r)).toThrow(new RangeError('invalid range'))
})

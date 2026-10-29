// @ts-nocheck -- standalone eval fixture
import { expect, test } from 'bun:test'
import { Queue } from './src/queue'
test('serial ordering including rejection recovery, 200 repetitions', async () => {
 for (let i=0;i<200;i++) {
  const q = new Queue(); const events = []
  const a=q.add(async()=>{events.push('a:start'); await new Promise(r=>setTimeout(r,1)); events.push('a:end'); return 7})
  const b=q.add(async()=>{events.push('b'); throw new Error('job failed')}); const rejected=b.catch(e=>e.message)
  const c=q.add(()=>{events.push('c'); return 9})
  expect(await a).toBe(7); expect(await rejected).toBe('job failed'); expect(await c).toBe(9)
  expect(events).toEqual(['a:start','a:end','b','c'])
 }
})

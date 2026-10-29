import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

export const families = [
  'interval-overlay',
  'atomic-transfer',
  'single-flight',
  'event-bus',
  'async-pool',
] as const
export const TRAINING_PER_FAMILY = 8
export const HELDOUT_PER_FAMILY = 40
export const DRY_TRAINING_PER_FAMILY = 2
export const DRY_HELDOUT_PER_FAMILY = 4
export type Family = (typeof families)[number]
export const taskSchema = z
  .object({
    id: z.string().regex(/^(train|heldout)-\d+$/),
    split: z.enum(['train', 'heldout']),
    family: z.enum(families),
    seed: z.number().int().positive(),
    prompt: z.string().min(1),
    timeout_s: z.number().positive(),
  })
  .strict()
export type Task = z.infer<typeof taskSchema>

/** Clauses are shown verbatim in both the prompt and README. Hidden groups cite them. */
export const clauses = {
  'interval-overlay': {
    domain:
      'Layers are {start,end,tag} with integer endpoints in [-1000000,1000000], start <= end, and tags that are strings (including the empty string) or null.',
    overlay:
      'Process layers in input order over [start,end). A string tag pushes a paint layer; a null tag peels exactly one currently visible paint layer at each covered point, revealing the previous paint or leaving it uncovered. Peeling an uncovered point is a no-op. Equal-tag paints are separate history entries even when their visible output is coalesced. Ignore empty layers. Return sorted nonoverlapping {start,end,tag} spans of the final visible strings, coalescing touching spans with equal tags; omit uncovered points.',
    immutable:
      'Do not mutate input or enumerate individual points. Handle nested, crossing, negative and touching ranges.',
  },
  'atomic-transfer': {
    result:
      'Return a NEW plain object (Object.prototype or null prototype) with the same own enumerable account keys and final balances after a simultaneous batch. Account names may be JavaScript prototype names, including __proto__, constructor and toString; preserve them as own data properties.',
    values:
      'A move is {from,to,amount}; amount and every initial balance must be nonnegative safe integers. Reject invalid amounts or initial balances with RangeError, including when moves is empty.',
    ownKeys:
      'Both accounts must be OWN keys. Reject missing own accounts with RangeError, even when that name exists on the prototype.',
    final:
      'Accumulate the simultaneous batch exactly, then reject negative or unsafe FINAL balances with RangeError. Intermediate totals may be negative or outside the safe integer range; validate only the final totals. Self transfers have no effect but still validate their amount and accounts.',
    immutable:
      'On success or failure, never mutate balances or moves. Frozen balances, move arrays and move objects are valid inputs.',
    retries:
      'A move may carry an id. Undefined id means anonymous: apply every occurrence. Otherwise id must be a string (including empty and prototype names), or throw RangeError. Apply identical repeats of an id with the same from, to and amount only once. Reusing an id with a different payload must throw RangeError; self transfers still reserve their id. Validate all moves, including ignored repeats, before returning a result.',
  },
  'single-flight': {
    constructor:
      'new Cache(loader, ttl, now) uses an injected clock function. The constructor must throw RangeError unless ttl is a positive finite number, including for 0, negative values, Infinity and NaN.',
    pending:
      'get(key) returns a Promise; concurrent gets for the same key share ONE loader call. Different keys are independent.',
    expiry:
      'Values including undefined are cached until now() >= completionTime + ttl; TTL starts when the loader completes, not when get is called.',
    rejection:
      'Rejections are never cached. Loader may return synchronously or throw synchronously; get must always return a Promise and turn synchronous throws into rejections.',
    invalidation:
      'invalidate(key) removes cached AND pending ownership; an already pending caller still gets its own result or rejection, but stale completion/rejection must not overwrite or delete a newer generation.',
  },
  'event-bus': {
    registration:
      'createBus() returns {on, emit}. on(event, listener, {once=false}={}) returns an unsubscribe function: it returns true on the first removal of an active registration and false thereafter. Event names are arbitrary strings, including empty and prototype names. Duplicate listener functions are independent registrations. Listeners receive all emit arguments in order.',
    snapshot:
      'emit(event,...args) invokes registrations synchronously in registration order from a snapshot taken at the start of that emit. Skip a listener removed before its turn. Additions do not join the current emit, but are visible to later or nested emits. Remove once listeners BEFORE calling them, including when they throw or reenter emit. Nested emits take their own snapshots of currently active registrations.',
    errors:
      'Continue notifying remaining listeners after a listener throws. After the snapshot completes, throw AggregateError whose errors array contains the thrown values in invocation order, including non-Error and falsy values; do not flatten a thrown AggregateError. With no thrown values, return the count of listeners invoked by this emit (excluding nested emits).',
  },
  'async-pool': {
    capacity:
      'new Pool(limit) requires a positive integer limit and otherwise throws RangeError. run(job, signal?) always returns a Promise. Each pool has independent capacity. Jobs are functions returning a value or Promise, or throwing synchronously; invoke them from a microtask and never exceed limit concurrently unsettled jobs.',
    fifo: 'Start jobs in FIFO submission order, skipping cancelled entries. Synchronous throws and promise rejections release capacity exactly once and do not block later work. A job submitted reentrantly joins the tail behind older queued jobs.',
    cancellation:
      'An already-aborted or queued-aborted signal rejects that caller immediately with signal.reason and never invokes its job. If aborted after the job starts, reject its caller immediately with signal.reason, but retain its capacity until the underlying job settles: cancellation does not preempt running work. Aborting between run and the job-start microtask must also skip the job. A late settlement cannot overwrite an abort rejection; a late abort cannot change an already-settled result. Handle underlying rejections even after abort. Request abort rejection synchronously in the abort notification (or in run when already aborted); Promise reactions still run asynchronously.',
  },
} as const

export const specifications: Record<Family, string> = Object.fromEntries(
  families.map((family) => [
    family,
    `Repair ${family === 'interval-overlay' ? 'overlay(layers)' : family === 'atomic-transfer' ? 'transfer(balances, moves)' : family === 'single-flight' ? 'Cache' : family === 'event-bus' ? 'createBus()' : 'Pool'} in src/subject.ts. ${Object.values(clauses[family]).join(' ')}`,
  ]),
) as Record<Family, string>

export const initialSources: Record<Family, string> = {
  'interval-overlay':
    'export function overlay(layers) { return layers.map(x=>({...x})).sort((a,b)=>a.start-b.start) }',
  'atomic-transfer':
    'export function transfer(balances,moves) { for(const x of moves){ balances[x.from]-=x.amount; balances[x.to]+=x.amount } return balances }',
  'single-flight':
    'export class Cache { constructor(loader,ttl,now){this.loader=loader} async get(key){return this.loader(key)} invalidate(key){} }',
  'event-bus': 'export function createBus(){ return { on(){return ()=>false}, emit(){return 0} } }',
  'async-pool':
    'export class Pool { constructor(limit){} run(job,signal){return Promise.resolve().then(job)} }',
}

/** Reference implementations are used ONLY by the scripted mock provider and oracle tests. */
export const solutions: Record<Family, string> = {
  'interval-overlay': `export function overlay(layers) {
 const points=[...new Set(layers.flatMap(x=>[x.start,x.end]))].sort((a,b)=>a-b), out=[];
 for(let i=0;i<points.length-1;i++) {const start=points[i],end=points[i+1]; const stack=[];for(const layer of layers){if(layer.start<=start&&layer.end>=end&&layer.start<layer.end){if(layer.tag===null)stack.pop();else stack.push(layer.tag);}} const tag=stack.at(-1);if(tag===undefined)continue;
 const prev=out.at(-1); if(prev&&prev.end===start&&prev.tag===tag)prev.end=end; else out.push({start,end,tag}); } return out;
}`,
  'atomic-transfer': `export function transfer(balances,moves) {
 const totals=new Map(),ids=new Map(); for(const k of Object.keys(balances)){if(!Number.isSafeInteger(balances[k])||balances[k]<0)throw new RangeError('balance'); totals.set(k,BigInt(balances[k]));}
 for(const x of moves){if(!Object.hasOwn(balances,x.from)||!Object.hasOwn(balances,x.to)||!Number.isSafeInteger(x.amount)||x.amount<0)throw new RangeError('move'); if(x.id!==undefined){if(typeof x.id!=='string')throw new RangeError('id');const payload=JSON.stringify([x.from,x.to,x.amount]);if(ids.has(x.id)){if(ids.get(x.id)!==payload)throw new RangeError('conflicting id');continue;}ids.set(x.id,payload);} const n=BigInt(x.amount); totals.set(x.from,totals.get(x.from)-n); totals.set(x.to,totals.get(x.to)+n);}
 const out={}; for(const [k,n] of totals){if(n<0n||n>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('final'); Object.defineProperty(out,k,{value:Number(n),enumerable:true,writable:true,configurable:true});}return out;
}`,
  'single-flight': `export class Cache {
 constructor(loader,ttl,now){if(!Number.isFinite(ttl)||ttl<=0)throw new RangeError('ttl');this.loader=loader;this.ttl=ttl;this.now=now;this.entries=new Map();}
 get(key){const old=this.entries.get(key);if(old&&(old.pending||this.now()<old.until))return old.promise;
 const e={pending:true,until:Infinity,promise:null};this.entries.set(key,e);
 e.promise=Promise.resolve().then(()=>this.loader(key)).then(value=>{if(this.entries.get(key)===e){e.pending=false;e.until=this.now()+this.ttl;}return value;},error=>{if(this.entries.get(key)===e)this.entries.delete(key);throw error;});return e.promise;}
 invalidate(key){this.entries.delete(key);}
}`,
  'event-bus': `export function createBus(){
 const events=new Map();return {
 on(event,fn,{once=false}={}){const entry={fn,once,active:true};const list=events.get(event)||[];list.push(entry);events.set(event,list);return ()=>{if(!entry.active)return false;entry.active=false;return true;};},
 emit(event,...args){const list=events.get(event)||[];let count=0;const errors=[];for(const entry of [...list]){if(!entry.active)continue;if(entry.once)entry.active=false;count++;try{entry.fn(...args)}catch(error){errors.push(error)}}if(errors.length)throw new AggregateError(errors);return count;}
 };}
`,
  'async-pool': `export class Pool {
 constructor(limit){if(!Number.isInteger(limit)||limit<1)throw new RangeError('limit');this.limit=limit;this.active=0;this.queue=[];}
 run(job,signal){return new Promise((resolve,reject)=>{const e={job,signal,resolve,reject,aborted:false,done:false};e.abort=()=>{if(e.done)return;e.aborted=true;reject(signal.reason);this.pump();};if(signal?.aborted){reject(signal.reason);return;}signal?.addEventListener('abort',e.abort,{once:true});this.queue.push(e);this.pump();});}
 pump(){while(this.active<this.limit&&this.queue.length){const e=this.queue.shift();if(e.aborted){e.signal?.removeEventListener('abort',e.abort);continue;}this.active++;Promise.resolve().then(()=>{if(!e.aborted)return e.job();}).then(value=>{if(!e.aborted)e.resolve(value);},error=>{if(!e.aborted)e.reject(error);}).finally(()=>{e.done=true;this.active--;e.signal?.removeEventListener('abort',e.abort);this.pump();});}}
}
`,
}

/** Plausible partial fixes: public examples pass; independent hidden checks reject them. */
export function partialSolution(family: Family): string {
  const source = solutions[family]
  if (family === 'interval-overlay') return source.replace('prev.tag===tag', 'true')
  if (family === 'atomic-transfer') return source.replace('if(ids.has(x.id))', 'if(false)')
  if (family === 'event-bus')
    return source.replace('for(const entry of [...list])', 'for(const entry of list)')
  if (family === 'async-pool')
    return source.replace(
      'e.aborted=true;reject(signal.reason);',
      'e.aborted=true;this.active--;reject(signal.reason);',
    )
  return source
    .replace('if(this.entries.get(key)===e)', 'if(true)')
    .replace('if(this.entries.get(key)===e)', 'if(true)')
}

export function generateStream(
  train = TRAINING_PER_FAMILY * families.length,
  heldout = HELDOUT_PER_FAMILY * families.length,
): Task[] {
  return (['train', 'heldout'] as const).flatMap((split) =>
    Array.from({ length: split === 'train' ? train : heldout }, (_, i) => {
      const family = families[i % families.length] as Family
      const seed = (split === 'train' ? 1000 : 100000) + i
      return taskSchema.parse({
        id: `${split}-${i}`,
        split,
        family,
        seed,
        timeout_s: 900,
        prompt: `${specifications[family]}\nRun bun test before and after changes. Add regression tests as needed. Complete the task in this session.\nFixture variant: ${family}/${seed}.`,
      })
    }),
  )
}

export function loadStream(value: unknown): Task[] {
  const tasks = z.array(taskSchema).min(1).parse(value)
  if (new Set(tasks.map((t) => t.id)).size !== tasks.length) throw new Error('Duplicate task ID')
  const seen = new Set<string>()
  for (const task of tasks) {
    const key = `${task.family}/${task.seed}`
    if (seen.has(key)) throw new Error('Train/held-out variant overlap')
    seen.add(key)
  }
  if (!tasks.some((t) => t.split === 'train') || !tasks.some((t) => t.split === 'heldout'))
    throw new Error('Both splits required')
  return tasks
}

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export async function materialize(task: Task, repo: string): Promise<void> {
  await mkdir(path.join(repo, 'src'), { recursive: true })
  await writeFile(
    path.join(repo, 'src/subject.ts'),
    `${initialSources[task.family]}\n// variant ${task.seed}\n`,
  )
  await writeFile(
    path.join(repo, 'README.md'),
    `${specifications[task.family]}\nVariant ${task.seed}.\n`,
  )
  // Stable path + named exception keep each recurring public failure class identifiable.
  const errorClass = `${task.family.replace(/(^|-)(\w)/g, (_, _prefix, c: string) => c.toUpperCase())}Error`
  const offset = (task.seed % 19) - 9
  const balance = 10 + (task.seed % 17)
  const amount = 1 + (task.seed % 5)
  const cases: Record<Family, string> = {
    'interval-overlay': `const a=[{start:${offset},end:${offset + 6},tag:'v${task.seed}'},{start:${offset + 2},end:${offset + 4},tag:'v${task.seed}'}]; assert.deepEqual(m.overlay(a),[{start:${offset},end:${offset + 6},tag:'v${task.seed}'}]);`,
    'atomic-transfer': `const a={a:${balance},b:0}; const b=m.transfer(a,[{from:'a',to:'b',amount:${amount}}]); assert.deepEqual({...b},{a:${balance - amount},b:${amount}}); assert.deepEqual(a,{a:${balance},b:0});`,
    'single-flight': `let n=0; const c=new m.Cache(async()=>++n,${amount},()=>${offset}); assert.equal(await c.get('v${task.seed}'),1); assert.equal(await c.get('v${task.seed}'),1); assert.equal(n,1);`,
    'event-bus': `const seen=[];const bus=m.createBus();bus.on('v${task.seed}',value=>seen.push(value));assert.equal(bus.emit('v${task.seed}',${amount}),1);assert.deepEqual(seen,[${amount}]);`,
    'async-pool': `const pool=new m.Pool(1);const seen=[];let release;const gate=new Promise(r=>release=r);const a=pool.run(async()=>{seen.push('a');await gate;seen.push('end')});const b=pool.run(()=>seen.push('b'));while(!seen.length)await new Promise(r=>setImmediate(r));assert.deepEqual(seen,['a']);release();await Promise.all([a,b]);assert.deepEqual(seen,['a','end','b']);`,
  }
  if (task.family === 'atomic-transfer') {
    cases[task.family] +=
      `const named=JSON.parse('{"__proto__":5,"a":0}'); const copied=m.transfer(named,[]); assert.equal(Object.hasOwn(copied,'__proto__'),true); assert.equal(copied.__proto__,5);`
    cases[task.family] +=
      task.seed % 2 === 0
        ? `assert.throws(()=>m.transfer({a:1,b:0},[{from:'a',to:'b',amount:2}]),RangeError);`
        : `assert.throws(()=>m.transfer({a:1,b:Number.MAX_SAFE_INTEGER},[{from:'a',to:'b',amount:1}]),RangeError);`
  }
  await writeFile(
    path.join(repo, 'contract.test.ts'),
    `import {test} from 'bun:test'; import assert from 'node:assert/strict'; import * as m from './src/subject';\nclass ${errorClass} extends Error {name='${errorClass}'}\ntest('${task.family}',async()=>{try{${cases[task.family]}}catch(e){throw new ${errorClass}(String(e))}});\n`,
  )
}

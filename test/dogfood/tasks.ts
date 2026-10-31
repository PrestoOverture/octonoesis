import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  type ExtraFamily,
  extraClauses,
  extraInitial,
  extraPartial,
  extraPublic,
  extraSolutions,
} from './extra-tasks'

import {
  type ExtraFamily2,
  extraClauses2,
  extraInitial2,
  extraPartial2,
  extraPublic2,
  extraSolutions2,
} from './extra-tasks2'
import {
  type ExtraFamily3,
  extraClauses3,
  extraInitial3,
  extraPartial3,
  extraPublic3,
  extraSolutions3,
} from './extra-tasks3'

export const families = [
  'interval-overlay',
  'atomic-transfer',
  'single-flight',
  'event-bus',
  'async-pool',
  'csv-records',
  'dependency-plan',
  'merge-patch',
  'civil-date',
  'ranked-vote',
  'ini-config',
  'utf8-codec',
  'semver-range',
  'query-string',
  'json-pointer',
  'money-allocate',
  'token-bucket',
  'debounce-scheduler',
  'rational-math',
  'stable-heap',
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
  ...extraClauses,
  ...extraClauses2,
  ...extraClauses3,
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
      'Accumulate the simultaneous batch exactly, then reject negative or unsafe FINAL balances with RangeError. Intermediate totals may be negative or outside the safe integer range; validate only the final totals. Exact means mathematical integer arithmetic: ordinary Number addition can lose a unit even when all inputs and final balances are safe integers. Use BigInt (or an equally exact method) for all totals/deltas, then convert valid final balances back to Number. For example, with M=Number.MAX_SAFE_INTEGER, the mathematical expression 1+M+M-1-M-M equals 0 and must stay 0. Self transfers have no effect but still validate their amount and accounts.',
    immutable:
      'On success or failure, never mutate balances or moves. Frozen balances, move arrays and move objects are valid inputs.',
    retries:
      'A move may carry an id. Undefined id means anonymous: apply every occurrence. Otherwise id must be a string (including empty and prototype names), or throw RangeError. Apply identical repeats of an id with the same from, to and amount only once. Reusing an id with a different payload must throw RangeError; self transfers still reserve their id. Validate all moves, including ignored repeats, before returning a result.',
  },
  'single-flight': {
    constructor:
      'new Cache(loader, ttl, now) uses an injected clock function. The constructor must throw RangeError unless ttl is a positive finite number, including for 0, negative values, Infinity and NaN.',
    pending:
      'get(key) returns a Promise; concurrent gets for the same key share ONE loader call. Different keys are independent. Pending ownership must be installed before invoking the loader and removed on settlement, including synchronous failure.',
    expiry:
      'Values including undefined are cached until now() >= completionTime + ttl; TTL starts when the loader completes, not when get is called.',
    rejection:
      'Rejections are never cached; the next get after a rejection must retry the loader. Loader may return synchronously or throw synchronously; get must always return a Promise and turn synchronous throws into rejections.',
    invalidation:
      'invalidate(key) removes cached AND pending ownership; an already pending caller still gets its own result or rejection, but stale completion/rejection must not overwrite or delete a newer generation. Always settle the original caller with the loader outcome, even after invalidation; ownership controls cache writes only.',
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
      'Cancellation applies only before a job starts. An already-aborted or queued-aborted signal rejects that caller immediately with signal.reason and never invokes its job. Aborting between run and the job-start microtask must also skip the job. Once the job starts, ignore its signal: its caller receives the underlying result or rejection, and its capacity stays occupied until settlement. Request pre-start abort rejection synchronously in the abort notification (or in run when already aborted); Promise reactions still run asynchronously.',
  },
} as const

export const specifications: Record<Family, string> = Object.fromEntries(
  families.map((family) => [
    family,
    `Repair ${family === 'interval-overlay' ? 'overlay(layers)' : family === 'atomic-transfer' ? 'transfer(balances, moves)' : family === 'single-flight' ? 'Cache' : family === 'event-bus' ? 'createBus()' : family === 'async-pool' ? 'Pool' : family} in src/subject.ts. ${Object.values(clauses[family]).join(' ')}`,
  ]),
) as Record<Family, string>

export const initialSources: Record<Family, string> = {
  ...extraInitial,
  ...extraInitial2,
  ...extraInitial3,
  'interval-overlay':
    'export function overlay(layers) { return layers.map(x=>({...x})).sort((a,b)=>a.start-b.start) }',
  'atomic-transfer':
    'export function transfer(balances,moves) { for(const x of moves){ balances[x.from]-=x.amount; balances[x.to]+=x.amount } return balances }',
  'single-flight': `export class Cache {
 constructor(loader,ttl,now){this.loader=loader;this.ttl=ttl;this.now=now;this.entries=new Map();}
 get(key){const existing=this.entries.get(key);if(existing?.pending)return existing.promise;
 const entry={pending:true,promise:null};this.entries.set(key,entry);
 // Install ownership before invoking user code. Keep caller settlement independent of cache ownership.
 entry.promise=Promise.resolve().then(()=>this.loader(key)).finally(()=>{if(this.entries.get(key)===entry)this.entries.delete(key);});
 // TODO: validate ttl, cache successful values until completion + ttl, and invalidate ownership.
 return entry.promise;}
 invalidate(key){}
}`,
  'event-bus': 'export function createBus(){ return { on(){return ()=>false}, emit(){return 0} } }',
  'async-pool':
    'export class Pool { constructor(limit){} run(job,signal){return Promise.resolve().then(job)} }',
}

/** Reference implementations are used ONLY by the scripted mock provider and oracle tests. */
export const solutions: Record<Family, string> = {
  ...extraSolutions,
  ...extraSolutions2,
  ...extraSolutions3,
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
 pump(){while(this.active<this.limit&&this.queue.length){const e=this.queue.shift();if(e.aborted){e.signal?.removeEventListener('abort',e.abort);continue;}this.active++;Promise.resolve().then(()=>{e.signal?.removeEventListener('abort',e.abort);if(!e.aborted)return e.job();}).then(value=>{if(!e.aborted)e.resolve(value);},error=>{if(!e.aborted)e.reject(error);}).finally(()=>{e.done=true;this.active--;e.signal?.removeEventListener('abort',e.abort);this.pump();});}}
}
`,
}

/** Plausible partial fixes: public examples pass; independent hidden checks reject them. */
export function partialSolution(family: Family): string {
  if (family in extraClauses3) return extraPartial3(family as ExtraFamily3)
  if (family in extraClauses2) return extraPartial2(family as ExtraFamily2)
  if (family in extraClauses) return extraPartial(family as ExtraFamily)
  const source = solutions[family]
  if (family === 'interval-overlay') return source.replace('prev.tag===tag', 'true')
  if (family === 'atomic-transfer') return source.replace('if(ids.has(x.id))', 'if(false)')
  if (family === 'event-bus')
    return source.replace('for(const entry of [...list])', 'for(const entry of list)')
  if (family === 'async-pool') return source.replace('e.aborted=true;', 'e.aborted=false;')
  return source
    .replace('if(this.entries.get(key)===e)', 'if(true)')
    .replace('if(this.entries.get(key)===e)', 'if(true)')
}

export function generateStream(
  train = TRAINING_PER_FAMILY * families.length,
  heldout = HELDOUT_PER_FAMILY * families.length,
  streamSeed = 1,
): Task[] {
  // Reserve disjoint numeric namespaces, including the oracle's uint32 PRNG input.
  if (!Number.isSafeInteger(streamSeed) || streamSeed < 1 || streamSeed > 4294)
    throw new Error('Stream seed must be an integer from 1 to 4294')
  if (
    !Number.isSafeInteger(train) ||
    train < 1 ||
    train > 99000 ||
    !Number.isSafeInteger(heldout) ||
    heldout < 1 ||
    heldout > 900000
  )
    throw new Error('Task counts exceed the reserved stream namespace')
  const offset = (streamSeed - 1) * 1000000
  return (['train', 'heldout'] as const).flatMap((split) =>
    Array.from({ length: split === 'train' ? train : heldout }, (_, i) => {
      const family = families[i % families.length] as Family
      const seed = offset + (split === 'train' ? 1000 : 100000) + i
      return taskSchema.parse({
        id: `${split}-${i}`,
        split,
        family,
        seed,
        timeout_s: 900,
        prompt: `${specifications[family]}\nRun bun test directly before and after changes, without pipes or redirection, so failing exit codes reach the learning loop. Keep contract.test.ts unchanged; add separate regression tests as needed. Complete the task in this session.\nFixture variant: ${family}/${seed}.`,
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
    ...extraPublic(task.seed),
    ...extraPublic2(task.seed),
    ...extraPublic3(task.seed),
    'interval-overlay': `const a=[{start:${offset},end:${offset + 6},tag:'v${task.seed}'},{start:${offset + 2},end:${offset + 4},tag:'v${task.seed}'}]; assert.deepEqual(m.overlay(a),[{start:${offset},end:${offset + 6},tag:'v${task.seed}'}]);`,
    'atomic-transfer': `const a={a:${balance},b:0}; const b=m.transfer(a,[{from:'a',to:'b',amount:${amount}}]); assert.deepEqual({...b},{a:${balance - amount},b:${amount}}); assert.deepEqual(a,{a:${balance},b:0});`,
    'single-flight': `let n=0; const c=new m.Cache(async()=>++n,${amount},()=>${offset}); assert.equal(await c.get('v${task.seed}'),1); assert.equal(await c.get('v${task.seed}'),1); assert.equal(n,1);`,
    'event-bus': `const seen=[];const bus=m.createBus();bus.on('v${task.seed}',value=>seen.push(value));assert.equal(bus.emit('v${task.seed}',${amount}),1);assert.deepEqual(seen,[${amount}]);`,
    'async-pool': `const pool=new m.Pool(1);const seen=[];let release;const gate=new Promise(r=>release=r);const a=pool.run(async()=>{seen.push('a');await gate;seen.push('end')});const b=pool.run(()=>seen.push('b'));while(!seen.length)await new Promise(r=>setImmediate(r));assert.deepEqual(seen,['a']);release();await Promise.all([a,b]);assert.deepEqual(seen,['a','end','b']);`,
  }
  const learnable: Record<Family, string> = {
    ...(Object.fromEntries(
      Object.keys({ ...extraClauses, ...extraClauses2, ...extraClauses3 }).map((family) => [
        family,
        '',
      ]),
    ) as Record<ExtraFamily | ExtraFamily2 | ExtraFamily3, string>),
    'interval-overlay': `assert.deepEqual(m.overlay([{start:0,end:2,tag:'a'},{start:2,end:4,tag:'b'}]),[{start:0,end:2,tag:'a'},{start:2,end:4,tag:'b'}]);assert.deepEqual(m.overlay([{start:0,end:3,tag:'old'},{start:1,end:2,tag:'new'},{start:1,end:2,tag:null}]),[{start:0,end:3,tag:'old'}]);`,
    'atomic-transfer': `const retry={from:'a',to:'b',amount:2,id:'retry'};assert.deepEqual({...m.transfer({a:6,b:0},[retry,retry])},{a:4,b:2});`,
    'single-flight': `let finish;let calls=0;const c2=new m.Cache(()=>++calls===1?new Promise((r,reject)=>finish=reject):Promise.resolve('new'),10,()=>0);const old=c2.get('key').catch(e=>e);while(!finish)await new Promise(r=>setImmediate(r));c2.invalidate('key');assert.equal(await c2.get('key'),'new');finish(new Error('old rejection'));await old;assert.equal(await c2.get('key'),'new');assert.equal(calls,2);`,
    'event-bus': `const b2=m.createBus();const log=[];let added=false;b2.on('event',()=>{log.push('first');if(!added){added=true;b2.on('event',()=>log.push('later'));}});b2.emit('event');assert.deepEqual(log,['first']);b2.emit('event');assert.deepEqual(log,['first','first','later']);`,
    'async-pool': `const p2=new m.Pool(1);const cancel=new AbortController();let called=false;const pending=p2.run(()=>{called=true},cancel.signal).catch(e=>e);cancel.abort('stop');assert.equal(await pending,'stop');await new Promise(r=>setImmediate(r));assert.equal(called,false);`,
  }
  cases[task.family] += learnable[task.family]
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
    `import {test} from 'bun:test'; import assert from 'node:assert/strict'; import {readFileSync,appendFileSync} from 'node:fs';\nconst source=readFileSync(new URL('./src/subject.ts',import.meta.url),'utf8');\nif(process.env.OCTONOESIS_DOGFOOD_ATTEMPTS)appendFileSync(process.env.OCTONOESIS_DOGFOOD_ATTEMPTS,JSON.stringify({source,started_at:new Date().toISOString()})+'\\n');\nclass ${errorClass} extends Error {name='${errorClass}'}\ntest('${task.family}',async()=>{try{const m=await import('./src/subject');${cases[task.family]}}catch(e){throw new ${errorClass}(String(e))}});\n`,
  )
}

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

export const families = ['interval-overlay', 'atomic-transfer', 'single-flight'] as const
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

const specifications: Record<Family, string> = {
  'interval-overlay':
    'Repair overlay(layers) in src/subject.ts. Layers are {start,end,tag} with integer endpoints in [-1000000,1000000], start <= end, and string tags. Each layer covers [start,end); later layers win. Ignore empty layers. Return sorted nonoverlapping {start,end,tag} spans covering exactly the union, coalescing touching spans with equal tags. Do not mutate input or enumerate individual points. Handle nested, crossing, negative and touching ranges.',
  'atomic-transfer':
    'Repair transfer(balances, moves) in src/subject.ts. Return a NEW plain object with the same own account keys and final balances after a simultaneous batch. A move is {from,to,amount}; amount and every balance must be nonnegative safe integers. Both accounts must be OWN keys. Reject malformed values, missing accounts, unsafe totals, or negative FINAL balances with RangeError. Intermediate negative balances are allowed: the batch is simultaneous. Self transfers have no effect but still validate. On success or failure, never mutate balances or moves. Account names may be JavaScript prototype names.',
  'single-flight':
    'Repair Cache in src/subject.ts. new Cache(loader, ttl, now) uses a positive finite ttl and an injected clock function. get(key) returns a Promise; concurrent gets for the same key share ONE loader call. Different keys are independent. Values including undefined are cached until now() >= completionTime + ttl. Rejections are never cached. invalidate(key) removes cached AND pending ownership; an already pending caller still gets its result, but stale completion/rejection must not overwrite or delete a newer generation. Loader may return synchronously or throw synchronously; get must always return a Promise.',
}

export const initialSources: Record<Family, string> = {
  'interval-overlay':
    'export function overlay(layers) { return layers.map(x=>({...x})).sort((a,b)=>a.start-b.start) }',
  'atomic-transfer':
    'export function transfer(balances,moves) { for(const x of moves){ balances[x.from]-=x.amount; balances[x.to]+=x.amount } return balances }',
  'single-flight':
    'export class Cache { constructor(loader,ttl,now){this.loader=loader} async get(key){return this.loader(key)} invalidate(key){} }',
}

/** Reference implementations are used ONLY by the scripted mock provider and oracle tests. */
export const solutions: Record<Family, string> = {
  'interval-overlay': `export function overlay(layers) {
 const points=[...new Set(layers.flatMap(x=>[x.start,x.end]))].sort((a,b)=>a-b), out=[];
 for(let i=0;i<points.length-1;i++) {const start=points[i],end=points[i+1]; const top=layers.findLast(x=>x.start<=start&&x.end>=end&&x.start<x.end); if(!top)continue;
 const prev=out.at(-1); if(prev&&prev.end===start&&prev.tag===top.tag)prev.end=end; else out.push({start,end,tag:top.tag}); } return out;
}`,
  'atomic-transfer': `export function transfer(balances,moves) {
 const totals=new Map(); for(const k of Object.keys(balances)){if(!Number.isSafeInteger(balances[k])||balances[k]<0)throw new RangeError('balance'); totals.set(k,BigInt(balances[k]));}
 for(const x of moves){if(!Object.hasOwn(balances,x.from)||!Object.hasOwn(balances,x.to)||!Number.isSafeInteger(x.amount)||x.amount<0)throw new RangeError('move'); const n=BigInt(x.amount); totals.set(x.from,totals.get(x.from)-n); totals.set(x.to,totals.get(x.to)+n);}
 const out={}; for(const [k,n] of totals){if(n<0n||n>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('final'); Object.defineProperty(out,k,{value:Number(n),enumerable:true,writable:true,configurable:true});}return out;
}`,
  'single-flight': `export class Cache {
 constructor(loader,ttl,now){if(!Number.isFinite(ttl)||ttl<=0)throw new RangeError('ttl');this.loader=loader;this.ttl=ttl;this.now=now;this.entries=new Map();}
 get(key){const old=this.entries.get(key);if(old&&(old.pending||this.now()<old.until))return old.promise;
 const e={pending:true,until:Infinity,promise:null};this.entries.set(key,e);
 e.promise=Promise.resolve().then(()=>this.loader(key)).then(value=>{if(this.entries.get(key)===e){e.pending=false;e.until=this.now()+this.ttl;}return value;},error=>{if(this.entries.get(key)===e)this.entries.delete(key);throw error;});return e.promise;}
 invalidate(key){this.entries.delete(key);}
}`,
}

/** Plausible partial fixes: public examples pass; independent hidden checks reject them. */
export function partialSolution(family: Family): string {
  const source = solutions[family]
  if (family === 'interval-overlay') return source.replace('prev.tag===top.tag', 'true')
  if (family === 'atomic-transfer')
    return source
      .replace('Object.hasOwn(balances,x.from)', '(x.from in balances)')
      .replace('Object.hasOwn(balances,x.to)', '(x.to in balances)')
  return source
    .replace('if(this.entries.get(key)===e)', 'if(true)')
    .replace('if(this.entries.get(key)===e)', 'if(true)')
}

export function generateStream(train = 24, heldout = 120): Task[] {
  return (['train', 'heldout'] as const).flatMap((split) =>
    Array.from({ length: split === 'train' ? train : heldout }, (_, i) => {
      const family = families[i % families.length] as Family
      const seed = (split === 'train' ? 1000 : 100000) + i
      return taskSchema.parse({
        id: `${split}-${i}`,
        split,
        family,
        seed,
        timeout_s: 300,
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
    'atomic-transfer': `const a={a:${balance},b:0}; const b=m.transfer(a,[{from:'a',to:'b',amount:${amount}}]); assert.deepEqual(b,{a:${balance - amount},b:${amount}}); assert.deepEqual(a,{a:${balance},b:0});`,
    'single-flight': `let n=0; const c=new m.Cache(async()=>++n,${amount},()=>${offset}); assert.equal(await c.get('v${task.seed}'),1); assert.equal(await c.get('v${task.seed}'),1); assert.equal(n,1);`,
  }
  await writeFile(
    path.join(repo, 'contract.test.ts'),
    `import {test} from 'bun:test'; import assert from 'node:assert/strict'; import * as m from './src/subject';\nclass ${errorClass} extends Error {name='${errorClass}'}\ntest('${task.family}',async()=>{try{${cases[task.family]}}catch(e){throw new ${errorClass}(String(e))}});\n`,
  )
}

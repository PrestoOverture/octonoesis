export const extraClauses3 = {
  'money-allocate': {
    ties: 'An optional third argument tieOrder is a permutation of all ratio indices, listed from highest to lowest priority for equal fractional remainders. Default to original index order. The output always stays in original ratio order; apply the same tie priority for negative totals. A supplied order with missing, repeated, noninteger or out-of-range indices throws RangeError, even for zero total or when no remainder units remain. Never mutate tieOrder; frozen arrays are valid.',
    split:
      'Export allocate(total, ratios). total is a safe integer in minor units; ratios is a nonempty array of nonnegative safe integers with a positive sum. Otherwise throw RangeError. Use exact integer arithmetic even when the ratio sum or products exceed the safe Number range. Never mutate ratios.',
    remainder:
      'Allocate abs(total) proportionally: floor each exact share, then distribute leftover units by descending fractional remainder, breaking ties by tieOrder when supplied, otherwise by original index. For negative totals negate the positive allocation, returning ordinary zero rather than -0.',
  },
  'token-bucket': {
    clock:
      'Export class TokenBucket(capacity, rate, now). capacity and rate must be positive finite numbers or throw RangeError. now is an injected numeric clock in seconds. Start full. take(amount=1) requires a positive finite amount or throws RangeError; return a boolean and deduct only if enough tokens.',
    refill:
      'Before each take, refill by elapsed seconds times rate, capped at capacity, retaining fractional tokens. A backward clock reading neither refills nor moves the last observed time backwards: use a high-water clock. Failed takes still advance refill time. Use no real timers.',
  },
  'debounce-scheduler': {
    api: 'Export debounce(fn, wait, scheduler, options={}), returning a callable with cancel() and flush(). scheduler has now(), set(delay, callback) returning a handle, and clear(handle). wait is positive finite; maxWait, when provided, is finite and at least wait; invalid values throw RangeError. options defaults to leading=false, trailing=true. Use only the injected scheduler.',
    timing:
      'Calls open a burst and reset its quiet deadline to now()+wait. leading invokes immediately on the first call. trailing invokes with the latest arguments and this at the quiet deadline; with leading enabled a lone call has no trailing invocation. maxWait forces a pending trailing invocation at firstCallTime+maxWait despite continuous calls. Deadlines are inclusive. A quiet or maxWait deadline closes the burst.',
    control:
      'Calls return the most recent invocation result (initially undefined). cancel clears the burst and pending invocation but retains that result. flush immediately closes the burst and invokes any pending trailing call, returning the latest result; repeated flush is inert. Clear old state BEFORE invoking fn so a reentrant call starts an independent burst whose timer survives. Disabled trailing never invokes on flush or maxWait.',
  },
  'rational-math': {
    fraction:
      'Export rational(n,d=1n), add(a,b), compare(a,b), and parse(text). Fractions are {n:bigint,d:bigint}. Normalize every result to coprime terms with positive denominator; zero is 0n/1n. Zero denominator throws RangeError. Do not mutate inputs. add and compare accept any fraction objects with a nonzero denominator, including unnormalized ones with a negative denominator, and treat them by value. add returns the exact sum; compare returns -1, 0 or 1 by exact value.',
    syntax:
      "parse accepts exactly two signed decimal integers separated by one slash, e.g. '-2/+4'; no whitespace or other syntax is accepted. Malformed text throws SyntaxError; a syntactically valid zero denominator throws RangeError. BigInt magnitude is unbounded.",
  },
  'stable-heap': {
    queue:
      'Export class StableHeap with push(value, priority), peek(), pop(), update(handle, priority), remove(handle), and size getter. Priorities are finite numbers or throw RangeError. push returns an opaque unique handle. peek/pop return the value with lowest priority, or undefined when empty. Equal priorities use original insertion order, including after updates. Values may be undefined.',
    handles:
      'update returns true for an active handle and changes only its priority; remove returns true and removes an active handle. Both return false for foreign or inactive handles. Removed or popped handles never revive. Invalid priority throws RangeError even for an inactive handle. Instances are independent; size counts active entries.',
  },
} as const
export type ExtraFamily3 = keyof typeof extraClauses3
export interface Scheduler {
  now(): number
  set(delay: number, callback: () => void): unknown
  clear(handle: unknown): void
}
export interface Debounced {
  (...args: unknown[]): unknown
  cancel(): void
  flush(): unknown
}
export interface ExtraSubject3 {
  allocate(total: number, ratios: readonly number[], tieOrder?: readonly number[]): number[]
  TokenBucket: new (
    capacity: number,
    rate: number,
    now: () => number,
  ) => { take(amount?: number): boolean }
  debounce(
    fn: (...args: unknown[]) => unknown,
    wait: number,
    scheduler: Scheduler,
    options?: { leading?: boolean; trailing?: boolean; maxWait?: number },
  ): Debounced
  rational(n: bigint, d?: bigint): { n: bigint; d: bigint }
  add(a: { n: bigint; d: bigint }, b: { n: bigint; d: bigint }): { n: bigint; d: bigint }
  compare(a: { n: bigint; d: bigint }, b: { n: bigint; d: bigint }): number
  parse(text: string): { n: bigint; d: bigint }
  StableHeap: new () => {
    push(value: unknown, priority: number): unknown
    peek(): unknown
    pop(): unknown
    update(handle: unknown, priority: number): boolean
    remove(handle: unknown): boolean
    readonly size: number
  }
}
export const extraSolutions3: Record<ExtraFamily3, string> = {
  'money-allocate':
    'export function allocate(total,ratios,tieOrder){if(!Number.isSafeInteger(total)||!ratios.length||ratios.some(x=>!Number.isSafeInteger(x)||x<0))throw new RangeError();const sum=ratios.reduce((a,b)=>a+BigInt(b),0n);if(!sum)throw new RangeError();const order=tieOrder===undefined?ratios.map((_,i)=>i):tieOrder;if(order.length!==ratios.length||new Set(order).size!==ratios.length||Array.from(order).some(i=>!Number.isInteger(i)||i<0||i>=ratios.length))throw new RangeError();const rank=[];order.forEach((i,r)=>rank[i]=r);const t=BigInt(Math.abs(total)),parts=ratios.map((r,i)=>({i,q:t*BigInt(r)/sum,r:t*BigInt(r)%sum}));let left=t-parts.reduce((a,b)=>a+b.q,0n);for(const p of [...parts].sort((a,b)=>a.r===b.r?rank[a.i]-rank[b.i]:a.r>b.r?-1:1)){if(left-->0n)p.q++;}return parts.map(p=>p.q===0n?0:Number(p.q)*(total<0?-1:1));}',
  'token-bucket':
    'export class TokenBucket{constructor(capacity,rate,now){if(!Number.isFinite(capacity)||capacity<=0||!Number.isFinite(rate)||rate<=0)throw new RangeError();Object.assign(this,{capacity,rate,now,tokens:capacity,time:now()});}take(amount=1){if(!Number.isFinite(amount)||amount<=0)throw new RangeError();const t=Math.max(this.time,this.now());this.tokens=Math.min(this.capacity,this.tokens+(t-this.time)*this.rate);this.time=t;if(this.tokens<amount)return false;this.tokens-=amount;return true;}}',
  'debounce-scheduler':
    'export function debounce(fn,wait,scheduler,{leading=false,trailing=true,maxWait}={}){if(!Number.isFinite(wait)||wait<=0||maxWait!==undefined&&(!Number.isFinite(maxWait)||maxWait<wait))throw new RangeError();let active=false,pending=false,start,quiet,timer,args,receiver,result;function reset(){if(active)scheduler.clear(timer);active=false;pending=false;args=receiver=undefined;}function finish(){const call=pending&&trailing,a=args,r=receiver;reset();if(call)result=fn.apply(r,a);return result;}function arm(){scheduler.clear(timer);timer=scheduler.set(Math.max(0,Math.min(quiet,maxWait===undefined||!trailing?Infinity:start+maxWait)-scheduler.now()),finish);}function wrapped(...a){const first=!active;args=a;receiver=this;if(first){active=true;start=scheduler.now();}quiet=scheduler.now()+wait;pending=!first||!leading;arm();if(first&&leading)result=fn.apply(this,a);return result;}wrapped.cancel=reset;wrapped.flush=()=>active?finish():result;return wrapped;}',
  'rational-math': `export function rational(n,d=1n){if(d===0n)throw new RangeError();if(d<0n){n=-n;d=-d;}let a=n<0n?-n:n,b=d;while(b){[a,b]=[b,a%b];}return {n:n/a,d:d/a};}export function add(a,b){return rational(a.n*b.d+b.n*a.d,a.d*b.d);}export function compare(a,b){a=rational(a.n,a.d);b=rational(b.n,b.d);const x=a.n*b.d-b.n*a.d;return x<0n?-1:x>0n?1:0;}export function parse(text){if(text.match(/^[+-]?[0-9]+[/][+-]?[0-9]+/)?.[0]!==text)throw new SyntaxError();const [n,d]=text.split('/').map(BigInt);return rational(n,d);}`,
  'stable-heap':
    'export class StableHeap{entries=[];seq=0;get size(){return this.entries.length;}valid(p){if(!Number.isFinite(p))throw new RangeError();}push(value,priority){this.valid(priority);const e={value,priority,seq:this.seq++};this.entries.push(e);return e;}first(){return [...this.entries].sort((a,b)=>a.priority-b.priority||a.seq-b.seq)[0];}peek(){return this.first()?.value;}pop(){const e=this.first();if(!e)return undefined;this.remove(e);return e.value;}update(handle,priority){this.valid(priority);if(!this.entries.includes(handle))return false;handle.priority=priority;return true;}remove(handle){const i=this.entries.indexOf(handle);if(i<0)return false;this.entries.splice(i,1);return true;}}',
}
export function extraPartial3(family: ExtraFamily3): string {
  const source = extraSolutions3[family]
  if (family === 'money-allocate') return source.replace('rank[a.i]-rank[b.i]', 'b.i-a.i')
  if (family === 'token-bucket')
    return source
      .replace('Math.max(this.time,this.now())', 'this.now()')
      .replace('(t-this.time)*this.rate', 'Math.max(0,t-this.time)*this.rate')
  if (family === 'debounce-scheduler')
    return source.replace(
      'reset();if(call)result=fn.apply(r,a);',
      'if(call)result=fn.apply(r,a);reset();',
    )
  if (family === 'rational-math') return source.replace('if(d<0n)', 'if(false)')
  return source.replace(
    'handle.priority=priority;',
    'handle.seq=this.seq++;handle.priority=priority;',
  )
}
export const extraInitial3 = Object.fromEntries(
  Object.keys(extraClauses3).map((f) => [f, extraPartial3(f as ExtraFamily3)]),
) as Record<ExtraFamily3, string>
export function extraPublic3(seed: number): Record<ExtraFamily3, string> {
  return {
    'money-allocate': `assert.deepEqual(m.allocate(-${4 + 3 * (seed % 4)},[1,1,1]),Array.from({length:3},(_,i)=>-(Math.floor(${4 + 3 * (seed % 4)}/3)+(i<${4 + 3 * (seed % 4)}%3?1:0))||0));`,
    'token-bucket':
      'let t=10;const b=new m.TokenBucket(2,1,()=>t);assert.equal(b.take(2),true);t=5;assert.equal(b.take(),false);t=10;assert.equal(b.take(),false);t=10.5;assert.equal(b.take(.5),true);',
    'debounce-scheduler': `let t=0,id=0;const jobs=new Map();const s={now:()=>t,set:(d,f)=>{jobs.set(++id,{at:t+d,f});return id},clear:h=>jobs.delete(h)};const seen=[];let d;d=m.debounce(v=>{seen.push(v);if(v===${seed})d(v+1)},2,s);d(${seed});d.flush();assert.equal(jobs.size,1);d.flush();assert.deepEqual(seen,[${seed},${seed + 1}]);`,
    'rational-math': `assert.deepEqual(m.parse('${seed}/-${seed * 2}'),{n:-1n,d:2n});assert.deepEqual(m.rational(0n,-5n),{n:0n,d:1n});`,
    'stable-heap': `const h=new m.StableHeap();const a=h.push('a${seed}',1);h.push('b',1);h.update(a,1);assert.equal(h.pop(),'a${seed}');assert.equal(h.pop(),'b');`,
  }
}

/** Five independent semantic domains; only specifications and public cases enter fixtures. */
export const extraClauses = {
  'csv-records': {
    format:
      'Export parseCSV(text), returning an array of rows of string fields. Commas separate fields; LF and CRLF separate records outside quotes. Track field state separately from accumulated text: an empty quoted field is still closed, and quoting is allowed after every comma, not only at row start. A quoted field starts with a double quote at field start, may contain commas, LF or CRLF verbatim, and escapes a double quote by doubling it. After its closing quote only a delimiter, record separator or end is legal. Quotes inside unquoted fields, bare CR outside quotes, and unterminated quotes throw SyntaxError. Spaces are ordinary data, never trimmed.',
    edges:
      'Empty input returns []. A final record separator does not add a phantom row. Empty fields and blank records are retained: comma yields [["",""]], LF yields [[""]], and a quoted empty field yields [[""]]. Do not mutate any external state.',
  },
  'dependency-plan': {
    graph:
      'Export plan(nodes, edges), where nodes are unique strings and each edge [before,after] requires before to precede after. Return a new array containing every node exactly once in topological order. At each step choose the lexicographically smallest currently available node using JavaScript string comparison (<), regardless of input order. Duplicate edges count once; disconnected nodes participate in the same ordering. Names may be empty or prototype names.',
    targets:
      'An optional third argument targets is an array of node names. When supplied, return only those targets and all their transitive prerequisites, with the same smallest-currently-available ordering in that induced graph; empty targets returns []. Duplicate targets count once. Unknown targets throw RangeError. Validate endpoints and cycles in the entire graph even when targets excludes them. Never mutate targets; frozen targets are valid.',
    errors:
      'Throw RangeError for any unknown edge endpoint or any cycle, including self cycles. Never mutate nodes, edges or their nested arrays; frozen inputs are valid.',
  },
  'merge-patch': {
    patch:
      'Export mergePatch(target, patch) for JSON values (null, booleans, finite numbers, strings, arrays and plain objects). A non-object patch, including null or an array, replaces the target with a deep copy of the patch. An object patch treats any non-object target (including arrays) as an empty object; for each own enumerable patch key, null deletes that key, otherwise recursively merge that value. Unmentioned target keys remain. Arrays are replaced, never merged by index.',
    ownership:
      'Return a deep copy with no object or array shared with either input, even for untouched subtrees. Never mutate either input; frozen inputs are valid. All keys, including __proto__, constructor and toString, are own data properties, not prototype operations. Use Object.defineProperty, Object.fromEntries or a null-prototype object for writes; ordinary assignment to __proto__ on {} invokes a setter. Test existing target keys with Object.hasOwn so inherited properties never become merge inputs. Result objects may have Object.prototype or null prototype.',
  },
  'civil-date': {
    calendar:
      'Export addDays(date, delta). Date is exactly YYYY-MM-DD with a valid Gregorian date in years 0001 through 9999; delta is a safe integer. Return the date delta civil days later in the same format, independent of local timezone or daylight saving. Gregorian leap years are divisible by 4 except centuries not divisible by 400.',
    errors:
      'Throw RangeError for malformed or impossible dates, non-safe-integer deltas, or results outside years 0001 through 9999. Do not normalize invalid dates. Zero delta still validates the date.',
  },
  'ranked-vote': {
    election:
      'Export elect(candidates, ballots). Candidates are unique strings, including empty and prototype names; each ballot is an array of strings ranked first to last. Ignore unknown names and later repetitions on a ballot. In each round each ballot votes for its first remaining candidate. Exhausted ballots do not count toward the majority denominator. Return a candidate with strictly more than half the nonexhausted votes. If no votes remain, return null (also for no candidates).',
    elimination:
      'When no candidate has a majority, eliminate exactly one candidate with the fewest votes, including zero votes. On a tie eliminate the lexicographically greatest name by JavaScript string comparison (<), then recount from the original rankings. Never mutate candidates, ballots or nested arrays; frozen inputs are valid.',
  },
} as const
export type ExtraFamily = keyof typeof extraClauses
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export interface ExtraSubject {
  parseCSV(text: string): string[][]
  plan(nodes: string[], edges: string[][], targets?: string[]): string[]
  mergePatch(target: Json, patch: Json): Json
  addDays(date: string, delta: number): string
  elect(candidates: string[], ballots: string[][]): string | null
}
export const extraInitial: Record<ExtraFamily, string> = {
  'csv-records': `export function parseCSV(text){
 if(text==='')return [];const rows=[];let row=[],field='',state='start';
 for(let i=0;i<text.length;i++){const c=text[i];
 if(state==='quoted'){if(c==='"'){if(text[i+1]==='"'){i++;}else state='closed';}else field+=c;continue;}
 if(c===','){row.push(field);field='';state='start';continue;}
 if(c==='\\n'||c==='\\r'){if(c==='\\r'){if(text[i+1]!=='\\n')throw new SyntaxError('CR');i++;}row.push(field);rows.push(row);row=[];field='';state='start';if(i===text.length-1)return rows;continue;}
 if(state==='closed')throw new SyntaxError('after quote');if(c==='"'){if(state!=='start')throw new SyntaxError('quote');state='quoted';}else{field+=c;state='plain';}}
 if(state==='quoted')throw new SyntaxError('unclosed');row.push(field);rows.push(row);return rows;}`,
  'dependency-plan': 'export function plan(nodes,edges){return [...nodes].sort()}',
  'merge-patch': `const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
 const put=(o,k,v)=>Object.defineProperty(o,k,{value:v,enumerable:true,writable:true,configurable:true});
 const clone=x=>Array.isArray(x)?x.map(clone):obj(x)?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,clone(v)])):x;
 // TODO: apply recursive merge/delete semantics; clone and put preserve independent own data properties.
 export function mergePatch(target,patch){return {...clone(target),...clone(patch)}}`,
  'civil-date':
    'export function addDays(date,delta){return new Date(Date.parse(date)+delta*86400000).toISOString().slice(0,10)}',
  'ranked-vote': 'export function elect(candidates,ballots){return candidates[0]??null}',
}
export const extraSolutions: Record<ExtraFamily, string> = {
  'csv-records': `export function parseCSV(text){
 if(text==='')return [];const rows=[];let row=[],field='',state='start';
 for(let i=0;i<text.length;i++){const c=text[i];
 if(state==='quoted'){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else state='closed';}else field+=c;continue;}
 if(c===','){row.push(field);field='';state='start';continue;}
 if(c==='\\n'||c==='\\r'){if(c==='\\r'){if(text[i+1]!=='\\n')throw new SyntaxError('CR');i++;}row.push(field);rows.push(row);row=[];field='';state='start';if(i===text.length-1)return rows;continue;}
 if(state==='closed')throw new SyntaxError('after quote');if(c==='"'){if(state!=='start')throw new SyntaxError('quote');state='quoted';}else{field+=c;state='plain';}}
 if(state==='quoted')throw new SyntaxError('unclosed');row.push(field);rows.push(row);return rows;}`,
  'dependency-plan': `export function plan(nodes,edges,targets){const next=new Map(nodes.map(n=>[n,new Set()])),degree=new Map(nodes.map(n=>[n,0]));for(const [a,b] of edges){if(!next.has(a)||!next.has(b))throw new RangeError('endpoint');if(!next.get(a).has(b)){next.get(a).add(b);degree.set(b,degree.get(b)+1);}}const out=[];while(out.length<nodes.length){const ready=nodes.filter(n=>degree.get(n)===0).sort();if(!ready.length)throw new RangeError('cycle');const n=ready[0];out.push(n);degree.set(n,-1);for(const b of next.get(n))degree.set(b,degree.get(b)-1);}if(targets===undefined)return out;const wanted=new Set();const visit=n=>{if(!next.has(n))throw new RangeError('target');if(wanted.has(n))return;wanted.add(n);for(const [a,b] of edges)if(b===n)visit(a);};for(const n of targets)visit(n);return out.filter(n=>wanted.has(n));}`,
  'merge-patch': `const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
 const clone=x=>Array.isArray(x)?x.map(clone):obj(x)?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,clone(v)])):x;
 export function mergePatch(target,patch){if(!obj(patch))return clone(patch);const out=obj(target)?clone(target):{};for(const [k,v] of Object.entries(patch)){if(v===null)delete out[k];else Object.defineProperty(out,k,{value:mergePatch(Object.hasOwn(out,k)?out[k]:undefined,v),enumerable:true,writable:true,configurable:true});}return out;}`,
  'civil-date': `export function addDays(date,delta){if(typeof date!=='string'||!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)||!Number.isSafeInteger(delta))throw new RangeError('input');const [y,m,d]=date.split('-').map(Number);const t=new Date(0);t.setUTCHours(0,0,0,0);t.setUTCFullYear(y,m-1,d);if(y<1||y>9999||t.getUTCFullYear()!==y||t.getUTCMonth()!==m-1||t.getUTCDate()!==d)throw new RangeError('date');const result=new Date(t.getTime()+delta*86400000);const year=result.getUTCFullYear();if(!Number.isFinite(result.getTime())||year<1||year>9999)throw new RangeError('range');return result.toISOString().slice(0,10);}`,
  'ranked-vote':
    'export function elect(candidates,ballots){const active=new Set(candidates);while(active.size){const counts=new Map([...active].map(n=>[n,0]));let total=0;for(const ballot of ballots){const n=ballot.find(x=>active.has(x));if(n!==undefined){counts.set(n,counts.get(n)+1);total++;}}if(!total)return null;for(const [n,count] of counts)if(count>total/2)return n;const loser=[...active].sort((a,b)=>counts.get(a)-counts.get(b)||(a<b?1:a>b?-1:0))[0];active.delete(loser);}return null;}',
}
export function extraPartial(family: ExtraFamily): string {
  const source = extraSolutions[family]
  if (family === 'csv-records') return source.replace("field+='\"';i++;", 'i++;')
  if (family === 'dependency-plan') return source.replace('if(!next.get(a).has(b))', 'if(true)')
  if (family === 'merge-patch')
    return source.replace('if(v===null)delete out[k];', 'if(v===null)out[k]=null;')
  if (family === 'civil-date')
    return source.replace('||t.getUTCMonth()!==m-1||t.getUTCDate()!==d', '')
  return source.replace('(a<b?1:a>b?-1:0)', '(a<b?-1:a>b?1:0)')
}
export function extraPublic(seed: number): Record<ExtraFamily, string> {
  const tag = `v${seed}`
  const day = 1 + (seed % 20)
  return {
    'csv-records': `assert.deepEqual(m.parseCSV('${tag},"a,b"\\r\\n"x""y",'),[['${tag}','a,b'],['x"y','']]);`,
    'dependency-plan': `assert.deepEqual(m.plan(['z','${tag}','a'],[['z','a'],['z','a']]),['${tag}','z','a']);`,
    'merge-patch': `assert.deepEqual(JSON.parse(JSON.stringify(m.mergePatch({keep:{x:${seed}},drop:1},{drop:null,add:[2]}))),{keep:{x:${seed}},add:[2]});`,
    'civil-date': `assert.equal(m.addDays('2024-02-${String(day).padStart(2, '0')}',1),'2024-02-${String(day + 1).padStart(2, '0')}');assert.equal(m.addDays('2000-02-28',1),'2000-02-29');assert.throws(()=>m.addDays('1900-02-29',0),RangeError);`,
    'ranked-vote': `assert.equal(m.elect(['z','${tag}','a'],[['z','a'],['${tag}','a'],['a']]),'a');`,
  }
}

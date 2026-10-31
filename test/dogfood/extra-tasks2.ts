/** Complete agent-visible contracts. Clause keys are stable private diagnostic IDs. */
export const extraClauses2 = {
  'ini-config': {
    syntax:
      'Export parseINI(text), returning an object of section objects; the empty section name holds keys before a header. Trim lines and key names. Ignore blank lines and lines beginning with # or ;. Headers are [name] with a nonempty trimmed name. Assignments split at the first = with a nonempty trimmed key. Repeated sections merge; the last duplicate key wins within its section. All names including prototype names are own data properties.',
    values:
      'Unquoted values are trimmed and end at the first # or ;. Double-quoted values preserve spaces and comment characters. A backslash introduces exactly one of n, r, t, double quote or backslash, decoding to newline, carriage return, tab, double quote or backslash respectively. After a closing quote only whitespace or a comment is legal. Malformed headers, assignments, quotes and unknown or dangling quoted escapes throw SyntaxError. LF and CRLF separate lines; empty input returns {}.',
  },
  'utf8-codec': {
    scalar:
      'Export encodeUTF8(points) returning a number array and decodeUTF8(bytes) returning a code point number array. Code points must be integers from 0 through 0x10ffff excluding surrogates 0xd800 through 0xdfff. Use canonical shortest UTF-8 with one through four bytes. Never mutate inputs; frozen arrays are valid.',
    errors:
      'Throw RangeError for invalid code points or bytes (bytes must be integers 0 through 255), stray continuation bytes, bad continuation bytes, truncated sequences, overlong encodings, encoded surrogates and values above 0x10ffff. Empty arrays round trip.',
  },
  'semver-range': {
    precedence:
      'Export compareVersions(a,b), returning -1, 0 or 1 for strict SemVer 2.0 strings with safe-integer major.minor.patch, optional prerelease and build identifiers. Numeric core and numeric prerelease identifiers forbid leading zeroes; identifiers contain ASCII letters, digits or hyphens and are nonempty. Ignore build metadata for precedence. Release beats prerelease; compare prerelease identifiers left to right, numeric below nonnumeric, numeric by integer magnitude and nonnumeric by ASCII order; a shorter equal prefix is lower.',
    ranges:
      'Export satisfies(version,range). Range is one or more whitespace-separated AND comparators: bare version or =, >, >=, <, <= immediately followed by a strict version, or ^version or ~version. Tilde allows versions below the next minor. Caret allows versions below the next major for major>0, next minor for 0.minor>0, and next patch for 0.0.patch. Lower bounds are inclusive. A prerelease candidate is excluded unless a comparator in the range explicitly has a prerelease with the same major.minor.patch. Invalid versions or unsupported/empty ranges throw RangeError, even if another comparator already fails.',
  },
  'query-string': {
    parse:
      'Export parseQuery(text), returning an object mapping decoded keys to arrays of decoded string values in occurrence order. Remove one initial ?. Split on &, ignore empty segments, split each segment at its first = (missing = means empty value). Replace + with space before percent-decoding UTF-8. Malformed percent escapes or invalid UTF-8 throw URIError. Empty and prototype-name keys must be own data properties.',
    stringify:
      'Export stringifyQuery(record), where own enumerable keys map to string arrays. Emit one key=value pair per element in Object.keys order and array order, joined by &, without ?. Encode keys and values using encodeURIComponent (spaces become %20, literal + becomes %2B); empty arrays emit nothing. Do not mutate either API input; frozen records and arrays are valid.',
  },
  'json-pointer': {
    tokens:
      'Export getPointer(document,pointer) and setPointer(document,pointer,value) for JSON values. Pointer is empty for the root or starts with /. Split tokens on /, then decode ~1 to / and ~0 to ~ in one left-to-right pass; any other ~ escape throws RangeError. Empty tokens and prototype-name object keys are ordinary own keys. Get requires every token to exist as an own property; missing paths or traversal through scalars throw RangeError.',
    arrays:
      'Array tokens must be canonical nonnegative decimal indices (0 or digits without leading zeroes). Get requires index < length. Set replaces an existing element, or appends at index length or final token -; - is invalid elsewhere. Set requires existing parent paths, creates or replaces a final object key, and empty pointer replaces the root. Return a deep independent copy, sharing no object with document or value; never mutate inputs, including on errors. Invalid array indices, missing parents and malformed pointers throw RangeError.',
  },
} as const
export type ExtraFamily2 = keyof typeof extraClauses2
export interface ExtraSubject2 {
  parseINI(text: string): Record<string, Record<string, string>>
  encodeUTF8(points: number[]): number[]
  decodeUTF8(bytes: number[]): number[]
  compareVersions(a: string, b: string): number
  satisfies(version: string, range: string): boolean
  parseQuery(text: string): Record<string, string[]>
  stringifyQuery(record: Record<string, string[]>): string
  getPointer(document: unknown, pointer: string): unknown
  setPointer(document: unknown, pointer: string, value: unknown): unknown
}
export const extraSolutions2: Record<ExtraFamily2, string> = {
  'ini-config': String.raw`export function parseINI(text){const out={};let section='';const put=(o,k,v)=>Object.defineProperty(o,k,{value:v,enumerable:true,writable:true,configurable:true});for(let line of text.split(/\r?\n/)){line=line.trim();if(!line||/^[#;]/.test(line))continue;if(line[0]==='['){if(!/^\[[^\]]+\]$/.test(line))throw new SyntaxError();section=line.slice(1,-1).trim();if(!section)throw new SyntaxError();if(!Object.hasOwn(out,section))put(out,section,{});continue;}const eq=line.indexOf('=');if(eq<1)throw new SyntaxError();const key=line.slice(0,eq).trim();if(!key)throw new SyntaxError();let raw=line.slice(eq+1).trim(),value='';if(raw[0]==='"'){let i=1,closed=false;for(;i<raw.length;i++){let c=raw[i];if(c==='"'){closed=true;i++;break;}if(c==='\\'){c=raw[++i];const escapes={n:'\n',r:'\r',t:'\t','"':'"','\\':'\\'};if(!Object.hasOwn(escapes,c))throw new SyntaxError();c=escapes[c];}value+=c;}if(!closed||!/^\s*(?:[#;].*)?$/.test(raw.slice(i)))throw new SyntaxError();}else value=raw.split(/[;#]/)[0].trim();if(!Object.hasOwn(out,section))put(out,section,{});put(out[section],key,value);}return out;}`,
  'utf8-codec': `export function encodeUTF8(points){const out=[];for(const p of points){if(!Number.isInteger(p)||p<0||p>0x10ffff||(p>=0xd800&&p<=0xdfff))throw new RangeError();if(p<128)out.push(p);else if(p<2048)out.push(192|(p>>6),128|(p&63));else if(p<65536)out.push(224|(p>>12),128|((p>>6)&63),128|(p&63));else out.push(240|(p>>18),128|((p>>12)&63),128|((p>>6)&63),128|(p&63));}return out;}
export function decodeUTF8(bytes){const out=[];for(const b of bytes)if(!Number.isInteger(b)||b<0||b>255)throw new RangeError();for(let i=0;i<bytes.length;){const b=bytes[i++];let n,p,min;if(b<128){out.push(b);continue;}if(b>=194&&b<=223){n=1;p=b&31;min=128;}else if(b>=224&&b<=239){n=2;p=b&15;min=2048;}else if(b>=240&&b<=244){n=3;p=b&7;min=65536;}else throw new RangeError();while(n--){const c=bytes[i++];if(c===undefined||(c&192)!==128)throw new RangeError();p=p*64+(c&63);}if(p<min||p>0x10ffff||(p>=0xd800&&p<=0xdfff))throw new RangeError();out.push(p);}return out;}`,
  'semver-range': String.raw`function parse(s){const m=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(s);if(!m||m[0]!==s)throw new RangeError();const core=m.slice(1,4).map(Number),pre=m[4]?.split('.')??[];if(core.some(n=>!Number.isSafeInteger(n))||pre.some(x=>/^\d+$/.test(x)&&x.length>1&&x[0]==='0'))throw new RangeError();return {core,pre};}
function cmp(a,b){for(let i=0;i<3;i++)if(a.core[i]!==b.core[i])return a.core[i]<b.core[i]?-1:1;if(!a.pre.length||!b.pre.length)return a.pre.length===b.pre.length?0:a.pre.length?-1:1;for(let i=0;i<Math.max(a.pre.length,b.pre.length);i++){const x=a.pre[i],y=b.pre[i];if(x===y)continue;if(x===undefined)return -1;if(y===undefined)return 1;const nx=/^\d+$/.test(x),ny=/^\d+$/.test(y);if(nx&&ny)return BigInt(x)<BigInt(y)?-1:1;if(nx!==ny)return nx?-1:1;return x<y?-1:1;}return 0;}
export function compareVersions(a,b){return cmp(parse(a),parse(b));}
export function satisfies(version,range){const v=parse(version);if(!range.trim())throw new RangeError();const parts=range.trim().split(/\s+/).map(s=>{const m=/^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(s);return {op:m[1]||'=',v:parse(m[2])};});if(v.pre.length&&!parts.some(p=>p.v.pre.length&&p.v.core.every((n,i)=>n===v.core[i])))return false;return parts.every(p=>{const c=cmp(v,p.v);if(p.op==='^'||p.op==='~'){const upper=[...p.v.core];const i=p.op==='~'?1:upper[0]>0?0:upper[1]>0?1:2;upper[i]++;for(let j=i+1;j<3;j++)upper[j]=0;return c>=0&&cmp(v,{core:upper,pre:[]})<0;}return p.op==='='?c===0:p.op==='>'?c>0:p.op==='>='?c>=0:p.op==='<'?c<0:c<=0;});}`,
  'query-string': `export function parseQuery(text){const out={};const decode=s=>decodeURIComponent(s.replaceAll('+',' '));for(const part of text.replace(/^\\?/,'').split('&')){if(!part)continue;const i=part.indexOf('='),key=decode(i<0?part:part.slice(0,i)),value=decode(i<0?'':part.slice(i+1));if(!Object.hasOwn(out,key))Object.defineProperty(out,key,{value:[],enumerable:true});out[key].push(value);}return out;}export function stringifyQuery(record){return Object.keys(record).flatMap(k=>record[k].map(v=>encodeURIComponent(k)+'='+encodeURIComponent(v))).join('&');}`,
  'json-pointer': String.raw`const clone=x=>x&&typeof x==='object'?Array.isArray(x)?x.map(clone):Object.fromEntries(Object.entries(x).map(([k,v])=>[k,clone(v)])):x;
function tokens(p){if(p==='')return [];if(p[0]!=='/')throw new RangeError();return p.slice(1).split('/').map(s=>{if(/~(?:[^01]|$)/.test(s))throw new RangeError();return s.replace(/~[01]/g,t=>t==='~0'?'~':'/');});}
function key(o,t,set){if(o===null||typeof o!=='object')throw new RangeError();if(Array.isArray(o)){if(set&&t==='-')return o.length;if(!/^(0|[1-9]\d*)$/.test(t))throw new RangeError();const n=Number(t);if(!Number.isSafeInteger(n)||n>o.length||(!set&&n===o.length))throw new RangeError();return n;}if(!set&&!Object.hasOwn(o,t))throw new RangeError();return t;}
export function getPointer(doc,p){for(const t of tokens(p))doc=doc[key(doc,t,false)];return doc;}
export function setPointer(doc,p,value){const ts=tokens(p);if(!ts.length)return clone(value);const out=clone(doc);let parent=out;for(const t of ts.slice(0,-1))parent=parent[key(parent,t,false)];const k=key(parent,ts.at(-1),true);Object.defineProperty(parent,k,{value:clone(value),enumerable:true,writable:true,configurable:true});return out;}`,
}
/** Starters are nearly complete implementations with one recurring semantic omission. */
export function extraPartial2(family: ExtraFamily2): string {
  const s = extraSolutions2[family]
  if (family === 'ini-config')
    return s.replace(
      'let raw=line.slice(eq+1).trim()',
      'let raw=line.slice(eq+1).trim().split(/[;#]/)[0].trim()',
    )
  if (family === 'utf8-codec') return s.replace('p<min||', '')
  if (family === 'semver-range')
    return s.replace(
      'if(v.pre.length&&!parts.some(p=>p.v.pre.length&&p.v.core.every((n,i)=>n===v.core[i])))return false;',
      '',
    )
  if (family === 'query-string') return s.replace("s.replaceAll('+',' ')", 's')
  return s.replace(
    "s.replace(/~[01]/g,t=>t==='~0'?'~':'/')",
    "s.replaceAll('~0','~').replaceAll('~1','/')",
  )
}
export const extraInitial2 = Object.fromEntries(
  Object.keys(extraClauses2).map((f) => [f, extraPartial2(f as ExtraFamily2)]),
) as Record<ExtraFamily2, string>
export function extraPublic2(seed: number): Record<ExtraFamily2, string> {
  return {
    'ini-config': `assert.deepEqual(m.parseINI('x=${seed} # comment\\n[s]\\nx="a;b"'),{'':{x:'${seed}'},s:{x:'a;b'}});`,
    'utf8-codec': `assert.deepEqual(m.encodeUTF8([${seed % 128},0x1f600]),[${seed % 128},240,159,152,128]);assert.deepEqual(m.decodeUTF8([240,159,152,128]),[0x1f600]);assert.throws(()=>m.decodeUTF8([224,128,128]),RangeError);`,
    'semver-range': `assert.equal(m.compareVersions('1.0.0-alpha.2','1.0.0-alpha.10'),-1);assert.equal(m.satisfies('1.2.3','^1.0.0'),true);assert.equal(m.satisfies('1.3.0-beta.${seed}','^1.2.0'),false);`,
    'query-string': `assert.deepEqual(m.parseQuery('?v=${seed}&v=a+b&__proto__=ok'),JSON.parse('{"v":["${seed}","a b"],"__proto__":["ok"]}'));assert.equal(m.stringifyQuery({v:['a b','+']}),'v=a%20b&v=%2B');`,
    'json-pointer': `assert.equal(m.getPointer({'~1':${seed}},'/~01'),${seed});assert.deepEqual(m.setPointer({a:[1]},'/a/-',2),{a:[1,2]});`,
  }
}

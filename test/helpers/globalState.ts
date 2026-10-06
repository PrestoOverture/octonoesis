// Snapshot/restore helpers for the process-global state that `bun test` shares
// across every test file in one run: the tool registry (src/tools/registry.ts)
// and the todo store (src/state/todos.ts).
//
// Built-in tools are registered exactly once, when src/query/engine.ts is first
// loaded. A test that calls clearRegistry() without re-registering what was
// there before silently strips those built-ins from every file that runs after
// it, so results depend on file order (in Ubuntu CI's order, a later App session
// saw `unknown_tool: Tool "Read" is not registered.`). The todo store leaks the
// same way: a todo set by one file appears in another file's TodoPanel.
//
// Tests that mutate either store snapshot in beforeEach and restore in afterEach
// with these helpers. The preload (test/setup.ts) then calls
// assertGlobalStateIntact() after every test, so any new leak fails at the test
// that caused it instead of in an unrelated file later in the run.
import { type Todo, clearTodos, getTodos, setTodos } from '../../src/state/todos'
import type { Tool } from '../../src/tools/Tool'
import { clearRegistry, getAllTools, getTool, registerTool } from '../../src/tools/registry'

/** Names engine.ts registers at module load; keep in sync with its registerTool() block. */
export const BUILTIN_TOOL_NAMES = [
  'Read',
  'Glob',
  'Bash',
  'Write',
  'Edit',
  'Grep',
  'TodoWrite',
] as const

/** Captures the current registry contents for a later restoreRegistry(). */
export function snapshotRegistry(): Tool[] {
  return getAllTools()
}

/** Replaces the registry with exactly the tools in `snapshot`. */
export function restoreRegistry(snapshot: readonly Tool[]): void {
  clearRegistry()
  for (const tool of snapshot) registerTool(tool)
}

/** Captures the current todo list for a later restoreTodos(). */
export function snapshotTodos(): Todo[] {
  return getTodos()
}

/**
 * Restores the todo list to `snapshot`. clearTodos() first drops the listeners
 * of components the test mounted, so restoring does not re-render them.
 */
export function restoreTodos(snapshot: Todo[]): void {
  clearTodos()
  setTodos(snapshot)
}

// The registry is empty until some test file first imports engine.ts, which can
// happen at any point in the run. So the guard arms itself the first time it sees
// every built-in registered, and records those exact instances. From then on each
// test must leave the same instances registered. Checking identity rather than
// just the names also catches a test that swapped in a fake 'Bash' and never
// put the real one back.
let canonicalBuiltins: Map<string, Tool> | undefined
let todosBefore: Todo[] | undefined

function armIfBuiltinsPresent(): void {
  if (canonicalBuiltins) return
  const found = new Map<string, Tool>()
  for (const name of BUILTIN_TOOL_NAMES) {
    const tool = getTool(name)
    if (!tool) return
    found.set(name, tool)
  }
  canonicalBuiltins = found
}

/** Called from the preload's global beforeEach. */
export function captureGlobalStateBeforeTest(): void {
  armIfBuiltinsPresent()
  todosBefore = getTodos()
}

/**
 * Describes how the registry or todo store differs from its expected state, or
 * returns undefined when nothing leaked. Does not change any state.
 */
export function describeGlobalStateLeak(): string | undefined {
  const problems: string[] = []
  if (canonicalBuiltins) {
    const missing: string[] = []
    const replaced: string[] = []
    for (const [name, tool] of canonicalBuiltins) {
      const current = getTool(name)
      if (current === undefined) missing.push(name)
      else if (current !== tool) replaced.push(name)
    }
    if (missing.length > 0) problems.push(`built-in tools not registered: ${missing.join(', ')}`)
    if (replaced.length > 0) {
      problems.push(`built-in tools replaced by another instance: ${replaced.join(', ')}`)
    }
  }
  if (todosBefore !== undefined) {
    // Compared by content: clearTodos() swaps in a fresh [] that is not a leak.
    const before = JSON.stringify(todosBefore)
    const after = JSON.stringify(getTodos())
    if (after !== before) problems.push(`todo store changed from ${before} to ${after}`)
  }
  if (problems.length === 0) return undefined
  return [
    `Test leaked process-global state (${problems.join('; ')}).`,
    'Snapshot with snapshotRegistry()/snapshotTodos() in beforeEach and restore with',
    'restoreRegistry()/restoreTodos() in afterEach (test/helpers/globalState.ts).',
  ].join(' ')
}

/**
 * Called from the preload's global afterEach, which Bun runs after the file's and
 * describe's own afterEach hooks. On a leak it first puts back the expected
 * state, so only the leaking test fails and later files are unaffected, then
 * throws.
 */
export function assertGlobalStateIntact(): void {
  armIfBuiltinsPresent()
  const leak = describeGlobalStateLeak()
  if (leak === undefined) return
  if (canonicalBuiltins) {
    for (const tool of canonicalBuiltins.values()) registerTool(tool)
  }
  if (todosBefore !== undefined) restoreTodos(todosBefore)
  throw new Error(leak)
}

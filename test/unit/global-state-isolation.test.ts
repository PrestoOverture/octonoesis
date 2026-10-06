import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import '../../src/query/engine'
import { getTodos, setTodos } from '../../src/state/todos'
import { clearRegistry, getTool, unregisterTool } from '../../src/tools/registry'
import {
  BUILTIN_TOOL_NAMES,
  describeGlobalStateLeak,
  restoreRegistry,
  restoreTodos,
  snapshotRegistry,
  snapshotTodos,
} from '../helpers/globalState'

// The guard that enforces registry/todo isolation lives in test/setup.ts's global
// afterEach, so it runs after every test in every file, whatever the order. This
// file checks that the guard can actually detect each kind of leak, and that its
// list of built-in names matches what engine.ts really registers.
describe('global state isolation guard', () => {
  it('sees every built-in tool registered once engine.ts has loaded', () => {
    const missing = BUILTIN_TOOL_NAMES.filter((name) => getTool(name) === undefined)
    expect(missing).toEqual([])
    expect(describeGlobalStateLeak()).toBeUndefined()
  })

  it('lists exactly the tools engine.ts registers at module load', async () => {
    const source = await readFile(path.resolve('src/query/engine.ts'), 'utf8')
    const calls = source.match(/^registerTool\(\w+\)$/gm) ?? []
    expect(calls.length).toBe(BUILTIN_TOOL_NAMES.length)
  })

  it('reports a cleared registry and a swapped built-in', () => {
    const tools = snapshotRegistry()
    try {
      clearRegistry()
      expect(describeGlobalStateLeak()).toContain(
        `built-in tools not registered: ${BUILTIN_TOOL_NAMES.join(', ')}`,
      )

      restoreRegistry(tools)
      const bash = getTool('Bash')
      if (!bash) throw new Error('Bash not registered')
      unregisterTool('Bash')
      restoreRegistry([...snapshotRegistry(), { ...bash }])
      expect(describeGlobalStateLeak()).toContain('replaced by another instance: Bash')
    } finally {
      restoreRegistry(tools)
    }
    expect(describeGlobalStateLeak()).toBeUndefined()
  })

  it('reports todos left behind, but not a fresh empty list', () => {
    const todos = snapshotTodos()
    try {
      setTodos([{ id: 'leak', content: 'Write tests', status: 'open' }])
      expect(describeGlobalStateLeak()).toContain('todo store changed')
      setTodos([...getTodos().filter((todo) => todo.id !== 'leak')])
      expect(describeGlobalStateLeak()).toBeUndefined()
    } finally {
      restoreTodos(todos)
    }
    expect(describeGlobalStateLeak()).toBeUndefined()
  })
})

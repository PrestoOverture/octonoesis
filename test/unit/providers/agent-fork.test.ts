import { describe, expect, it } from 'bun:test'
import { prepareForkInput } from '../../../src/providers/fork'
import { MAX_FORK_PENDING_MESSAGES } from '../../../src/providers/forkChild'
import type { CanonicalTool } from '../../../src/providers/types'
import { AGENT_MAX_TURNS, AGENT_TIMEOUT_MS } from '../../../src/tools/AgentTool'

function tool(name: string): CanonicalTool {
  return { name, description: name, inputSchema: { type: 'object' } }
}

describe('agent fork invariants', () => {
  it('exports the Phase 35 agent budgets', () => {
    expect(AGENT_MAX_TURNS).toBe(12)
    expect(AGENT_TIMEOUT_MS).toBe(300_000)
    expect(MAX_FORK_PENDING_MESSAGES).toBe(16)
  })

  it('accepts only Read/Grep/Glob and rejects mutating and recursive tools', () => {
    const base = {
      forkPurpose: 'agent' as const,
      systemPrompt: 'stable',
      messages: [{ role: 'user' as const, content: 'research' }],
      repoRoot: process.cwd(),
    }
    expect(
      prepareForkInput({ ...base, tools: ['Read', 'Grep', 'Glob'].map(tool) }).tools.map(
        (entry) => entry.name,
      ),
    ).toEqual(['Read', 'Grep', 'Glob'])
    for (const name of ['Write', 'Edit', 'Bash', 'Agent', 'AgentTool']) {
      expect(() => prepareForkInput({ ...base, tools: [tool(name)] })).toThrow('tool_not_allowed')
    }
  })

  it('carries a real repoRoot and keeps message snapshots isolated', () => {
    const messages = [{ role: 'user' as const, content: 'original' }]
    const prepared = prepareForkInput({
      forkPurpose: 'agent',
      systemPrompt: 'stable',
      messages,
      tools: [],
      repoRoot: process.cwd(),
    })
    const first = messages[0]
    if (!first) throw new Error('missing test message')
    first.content = 'mutated'
    expect(prepared.repoRoot).toBe(process.cwd())
    expect(prepared.messages[0]).toEqual({ role: 'user', content: 'original' })
  })
})

import { z } from 'zod'
import { forkAgent } from '../providers/fork'
import type { CanonicalMessage, CanonicalTool, Usage } from '../providers/types'
import { READ_ONLY_FORK_SKILL_TOOLS } from '../skills/execute'
import { startLocalAgent } from '../tasks/localAgent'
import { zodToJsonSchema } from '../utils/schema'
import type { Tool, ToolContext, ToolResult } from './Tool'
import { getTool } from './registry'

const AgentInputSchema = z.object({
  description: z.string().min(1),
  prompt: z.string().min(1),
  background: z.boolean().optional(),
})

type AgentInput = z.infer<typeof AgentInputSchema>

export const AGENT_MAX_TURNS = 12
export const AGENT_TIMEOUT_MS = 300_000

export interface AgentToolOptions {
  systemPrompt: string
  model: string
  onForkUsage?: (usage: Usage) => void
}

/**
 * Collects the subset of registered tools that are read-only and safe for fork child agent use.
 *
 * @returns Array of canonical tool definitions available to the sub-agent.
 */
function readOnlyAgentTools(): CanonicalTool[] {
  return READ_ONLY_FORK_SKILL_TOOLS.flatMap((name) => {
    const tool = getTool(name)
    if (!tool) return []
    return [
      {
        name: tool.name,
        description: tool.description,
        inputSchema: zodToJsonSchema(tool.inputSchema) as Record<string, unknown>,
      },
    ]
  })
}

/**
 * Sanitizes messages before passing them to a fork child agent by pruning assistant tool_use blocks
 * that do not have a subsequent corresponding tool result message.
 *
 * @param messages - Array of canonical conversation messages.
 * @returns Sanitized array of canonical messages without unpaired tool calls.
 */
export function sanitizeAgentForkMessages(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.flatMap<CanonicalMessage>((message, index) => {
    if (message.role !== 'assistant') return [message]

    const laterToolResultIds = new Set(
      messages
        .slice(index + 1)
        .filter((candidate) => candidate.role === 'tool')
        .map((candidate) => (candidate.role === 'tool' ? candidate.tool_use_id : '')),
    )
    const content = message.content.filter(
      (block) => block.type !== 'tool_use' || laterToolResultIds.has(block.id),
    )
    if (content.length === 0) return []
    return content.length === message.content.length ? [message] : [{ ...message, content }]
  })
}

/**
 * Constructs the message history for a delegated agent by combining sanitized existing context
 * with the new user prompt.
 *
 * @param ctx - Tool context containing current conversation messages.
 * @param prompt - Delegated agent task prompt.
 * @returns Combined canonical message list for the sub-agent.
 */
function agentMessages(ctx: ToolContext, prompt: string): CanonicalMessage[] {
  return [
    ...sanitizeAgentForkMessages(structuredClone(ctx.messages ?? [])),
    { role: 'user' as const, content: [{ type: 'text' as const, text: prompt }] },
  ]
}

export class AgentTool
  implements Tool<AgentInput, string | { agentId: string; status: 'running' }>
{
  readonly name = 'Agent'
  readonly description =
    'Delegate a read-only research subtask. Foreground returns the result; background returns an agentId immediately, but one-shot session end kills any still-running background agent.'
  readonly inputSchema = AgentInputSchema

  /**
   * Initializes the AgentTool with system prompt, model, and fork usage reporting options.
   *
   * @param options - Configuration options for agent spawning.
   */
  constructor(private readonly options: AgentToolOptions) {}

  /**
   * Indicates whether Agent runs concurrently.
   *
   * @returns False, as sub-agent execution manages its own process and resources.
   */
  isConcurrencySafe(): boolean {
    return false
  }

  /**
   * Indicates whether Agent is considered read-only by the permission system.
   *
   * @returns False, requiring user confirmation before spawning sub-agents.
   */
  isReadOnly(): boolean {
    return false
  }

  /**
   * Delegates execution to an isolated sub-agent, either in the foreground or as a background task.
   *
   * @param input - Agent task parameters (prompt, description, background flag).
   * @param ctx - Tool execution context.
   * @returns ToolResult with either the text response (foreground) or agent ID object (background), or an error.
   */
  async call(
    input: AgentInput,
    ctx: ToolContext,
  ): Promise<ToolResult<string | { agentId: string; status: 'running' }>> {
    const forkOptions = {
      forkPurpose: 'agent' as const,
      systemPrompt: this.options.systemPrompt,
      messages: agentMessages(ctx, input.prompt),
      tools: readOnlyAgentTools(),
      model: this.options.model,
      maxTurns: AGENT_MAX_TURNS,
      timeoutMs: AGENT_TIMEOUT_MS,
      repoRoot: ctx.repoRoot,
    }

    try {
      if (input.background) {
        const record = await startLocalAgent({
          ctx,
          forkOptions,
          onForkUsage: this.options.onForkUsage,
          description: input.description,
        })
        return { ok: true, value: { agentId: record.agentId, status: 'running' } }
      }

      const result = await forkAgent({ ...forkOptions, signal: ctx.abortSignal })
      this.options.onForkUsage?.(result.usage)
      if (result.exitReason !== 'completed') {
        return { ok: false, error: result.error ?? `Agent exited: ${result.exitReason}` }
      }
      return { ok: true, value: result.text }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

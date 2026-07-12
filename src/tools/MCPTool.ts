import { z } from 'zod'
import type { McpClientConnection, McpRemoteTool } from '../mcp/types'
import type { Tool, ToolContext, ToolResult } from './Tool'

const structuralObjectSchema = z.record(z.string(), z.unknown())

export class MCPTool implements Tool<Record<string, unknown>, string> {
  readonly name: string
  readonly description: string
  readonly inputSchema = structuralObjectSchema
  readonly providerInputSchema: Record<string, unknown>

  constructor(
    readonly serverName: string,
    readonly remoteName: string,
    remoteTool: McpRemoteTool,
    private readonly connection: McpClientConnection,
  ) {
    this.name = `mcp__${serverName}__${remoteName}`
    this.description =
      remoteTool.description ?? `Call ${remoteName} on the ${serverName} MCP server.`
    this.providerInputSchema = remoteTool.inputSchema
  }

  isConcurrencySafe(): boolean {
    return false
  }

  isReadOnly(): boolean {
    return false
  }

  async call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult<string>> {
    try {
      const result = await this.connection.client.callTool(
        { name: this.remoteName, arguments: input },
        undefined,
        {
          signal: ctx.abortSignal,
          timeout: this.connection.timeoutMs,
          maxTotalTimeout: this.connection.timeoutMs,
        },
      )
      const serialized = JSON.stringify(result)
      if ('isError' in result && result.isError) {
        return { ok: false, error: `mcp_tool_error: ${serialized}` }
      }
      return { ok: true, value: serialized }
    } catch (error) {
      return {
        ok: false,
        error: `mcp_call_error: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
}

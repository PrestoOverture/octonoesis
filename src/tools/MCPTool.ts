import { z } from 'zod'
import type { McpClientConnection, McpRemoteTool } from '../mcp/types'
import type { Tool, ToolContext, ToolResult } from './Tool'

const structuralObjectSchema = z.record(z.string(), z.unknown())

export class MCPTool implements Tool<Record<string, unknown>, string> {
  readonly name: string
  readonly description: string
  readonly inputSchema = structuralObjectSchema
  readonly providerInputSchema: Record<string, unknown>

  /**
   * Initializes an MCP proxy tool wrapping a remote Model Context Protocol tool.
   *
   * @param serverName - Name of the remote MCP server hosting the tool.
   * @param remoteName - Original tool name exposed by the MCP server.
   * @param remoteTool - Metadata and schema of the remote tool.
   * @param connection - Active client connection used to invoke the tool.
   */
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

  /**
   * Indicates whether MCP tool calls can run concurrently.
   *
   * @returns False, as arbitrary remote MCP tools may perform state-mutating operations.
   */
  isConcurrencySafe(): boolean {
    return false
  }

  /**
   * Indicates whether MCP tool calls are read-only.
   *
   * @returns False, requiring user confirmation for arbitrary external tool execution.
   */
  isReadOnly(): boolean {
    return false
  }

  /**
   * Invokes the remote tool over the MCP client connection, passing abort signal and timeout constraints.
   *
   * @param input - Input arguments dictionary for the remote tool.
   * @param ctx - Tool execution context containing abort signal.
   * @returns ToolResult containing JSON stringified result or an error description.
   */
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

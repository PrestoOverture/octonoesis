import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { OctonoesisConfig } from '../config/schema'

export type McpServerConfig = OctonoesisConfig['mcpServers'][string]

/** Definition of a remote tool exposed by an external Model Context Protocol server. */
export interface McpRemoteTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/** Active connection state and client handle for an external MCP server. */
export interface McpClientConnection {
  name: string
  status: 'connected' | 'failed' | 'closed'
  client: Client
  transport: StdioClientTransport
  tools: McpRemoteTool[]
  timeoutMs: number
  cleanup: () => Promise<void>
}

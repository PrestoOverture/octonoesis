import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { OctonoesisConfig } from '../config/schema'

export type McpServerConfig = OctonoesisConfig['mcpServers'][string]

export interface McpRemoteTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface McpClientConnection {
  name: string
  status: 'connected' | 'failed' | 'closed'
  client: Client
  transport: StdioClientTransport
  tools: McpRemoteTool[]
  timeoutMs: number
  cleanup: () => Promise<void>
}

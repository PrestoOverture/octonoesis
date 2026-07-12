import { isActiveConfigTrusted } from '../config/load'
import type { QueryLoopContext } from '../query/types'
import { MCPTool } from '../tools/MCPTool'
import { registerTool, unregisterTool } from '../tools/registry'
import { dbg } from '../utils/debug'
import { connectMcpServer } from './client'
import type { McpClientConnection } from './types'

const sessionTools = new WeakMap<QueryLoopContext, MCPTool[]>()

export async function initializeMcp(ctx: QueryLoopContext): Promise<void> {
  if (ctx.mcpConnections) return
  ctx.mcpConnections = new Map()
  const config = ctx.config
  if (!config || Object.keys(config.mcpServers).length === 0) return

  if (!(await isActiveConfigTrusted(ctx.repoRoot, config))) {
    dbg('mcp', 'Tracked config is untrusted; MCP servers were not launched')
    return
  }

  const tools: MCPTool[] = []
  sessionTools.set(ctx, tools)
  const connected = await Promise.all(
    Object.entries(config.mcpServers).map(async ([serverName, serverConfig]) => {
      try {
        const connection = await connectMcpServer(serverName, serverConfig, ctx.repoRoot)
        return { serverName, connection }
      } catch (error) {
        dbg('mcp', `Failed to connect server "${serverName}"; continuing without it`, error)
        return undefined
      }
    }),
  )
  for (const entry of connected) {
    if (!entry) continue
    ctx.mcpConnections.set(entry.serverName, entry.connection)
    for (const remoteTool of entry.connection.tools) {
      const tool = new MCPTool(entry.serverName, remoteTool.name, remoteTool, entry.connection)
      tools.push(tool)
      registerTool(tool)
    }
  }
}

export async function cleanupMcp(ctx: QueryLoopContext): Promise<void> {
  const tools = sessionTools.get(ctx) ?? []
  sessionTools.delete(ctx)
  for (const tool of tools) unregisterTool(tool.name, tool)

  const connections = Array.from(ctx.mcpConnections?.values() ?? []) as McpClientConnection[]
  await Promise.allSettled(connections.map((connection) => connection.cleanup()))
  ctx.mcpConnections?.clear()
  ctx.mcpConnections = undefined
}

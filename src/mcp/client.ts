import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { dbg } from '../utils/debug'
import type { McpClientConnection, McpServerConfig } from './types'

const CLIENT_INFO = { name: 'octonoesis', version: '1.0.0' }

/**
 * Formats a user-friendly connection error when connecting to an MCP server fails or times out.
 *
 * @param serverName - Name of the MCP server.
 * @param timeoutMs - Configured connection timeout in milliseconds.
 * @param error - The caught error or rejection reason.
 * @returns An Error object with descriptive messaging.
 */
function connectionError(serverName: string, timeoutMs: number, error: unknown): Error {
  if (error instanceof Error && error.name === 'AbortError') {
    return new Error(`MCP server "${serverName}" timed out after ${timeoutMs}ms`, { cause: error })
  }
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Connects to a Model Context Protocol (MCP) server over standard I/O, queries available tools,
 * and returns an active client connection handle.
 *
 * @param serverName - Name identifying the MCP server instance.
 * @param config - Server configuration specifying executable command, args, environment, and timeout.
 * @param repoRoot - Working directory path to spawn the server process in.
 * @returns Active McpClientConnection containing connected client, tools list, and cleanup handler.
 * @throws Error If connection fails, times out, or fails during tool listing.
 */
export async function connectMcpServer(
  serverName: string,
  config: McpServerConfig,
  repoRoot: string,
): Promise<McpClientConnection> {
  const client = new Client(CLIENT_INFO)
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: repoRoot,
    stderr: 'pipe',
    ...(config.env ? { env: { ...getDefaultEnvironment(), ...config.env } } : {}),
  })
  transport.stderr?.on('data', (chunk) => {
    dbg('mcp', `${serverName} stderr`, String(chunk).trim())
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeout)
  let closed = false
  const cleanup = async (): Promise<void> => {
    if (closed) return
    closed = true
    await Promise.allSettled([client.close(), transport.close()])
  }

  try {
    await client.connect(transport, {
      signal: controller.signal,
      timeout: config.timeout,
      maxTotalTimeout: config.timeout,
    })
    const listed = await client.listTools(undefined, {
      signal: controller.signal,
      timeout: config.timeout,
      maxTotalTimeout: config.timeout,
    })
    const connection: McpClientConnection = {
      name: serverName,
      status: 'connected',
      client,
      transport,
      tools: listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      timeoutMs: config.timeout,
      cleanup: async () => {
        await cleanup()
        connection.status = 'closed'
      },
    }
    return connection
  } catch (error) {
    await cleanup()
    throw connectionError(serverName, config.timeout, error)
  } finally {
    clearTimeout(timer)
  }
}

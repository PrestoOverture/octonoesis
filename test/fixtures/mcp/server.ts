import fs from 'node:fs/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const marker = process.env.MCP_FIXTURE_MARKER
if (marker) await fs.appendFile(marker, `${process.pid}\n`)

const server = new McpServer({ name: 'octonoesis-test-server', version: '1.0.0' })
server.registerTool(
  'echo',
  {
    description: 'Echo a text value from the fixture MCP server.',
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({ content: [{ type: 'text', text: `fixture:${text}` }] }),
)

await server.connect(new StdioServerTransport())

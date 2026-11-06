import type { RPCSchema } from 'electrobun/rpc'
import type { HostCommand, HostMessage } from '../../../src/host/protocol'

export type DesktopRPC = {
  bun: RPCSchema<{
    requests: {
      openRepository: { params: undefined; response: { opened: boolean; error?: string } }
    }
    messages: { command: HostCommand }
  }>
  webview: RPCSchema<{
    requests: Record<never, never>
    messages: { host: HostMessage; hostExit: { message: string } }
  }>
}

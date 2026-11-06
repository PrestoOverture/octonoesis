import type { RPCSchema } from 'electrobun/rpc'
import type { HostCommand, HostMessage, PermissionMode } from '../../../src/host/protocol'
import type { Provider, ProviderSettings } from './providers'

type Opened = { opened: boolean; error?: string }

export type DesktopRPC = {
  bun: RPCSchema<{
    requests: {
      /** Dev builds only: OCTONOESIS_DEV_* launch options for unattended review. */
      startup: {
        params: undefined
        response: { screen?: 'settings'; prompt?: string; permissionMode?: PermissionMode } & Opened
      }
      openExternal: { params: { url: string }; response: { opened: boolean } }
      openRepository: { params: undefined; response: Opened }
      newSession: { params: undefined; response: Opened }
      resumeSession: { params: { sessionId: string }; response: Opened }
      getProviderSettings: { params: undefined; response: ProviderSettings }
      setProvider: { params: { provider: Provider }; response: ProviderSettings }
      saveApiKey: { params: { provider: Provider; key: string }; response: ProviderSettings }
      deleteApiKey: { params: { provider: Provider }; response: ProviderSettings }
    }
    messages: { command: HostCommand }
  }>
  webview: RPCSchema<{
    requests: Record<never, never>
    messages: { host: HostMessage; hostExit: { message: string } }
  }>
}

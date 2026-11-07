import type { RPCSchema } from 'electrobun/rpc'
import type { HostCommand, HostMessage, PermissionMode } from '../../../src/host/protocol'
import type { Provider, ProviderSettings } from './providers'

/** `key` names the live session (one engine host) a request started. */
type Opened = { opened: boolean; key?: string; error?: string }

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
      /** `repoRoot` must be a repository this window already opened. */
      newSession: { params: { repoRoot: string }; response: Opened }
      resumeSession: { params: { repoRoot: string; sessionId: string }; response: Opened }
      closeSession: { params: { key: string }; response: { closed: boolean } }
      getProviderSettings: { params: undefined; response: ProviderSettings }
      setProvider: { params: { provider: Provider }; response: ProviderSettings }
      saveApiKey: { params: { provider: Provider; key: string }; response: ProviderSettings }
      deleteApiKey: { params: { provider: Provider }; response: ProviderSettings }
    }
    messages: { command: { key: string; command: HostCommand } }
  }>
  webview: RPCSchema<{
    requests: Record<never, never>
    messages: {
      host: { key: string; message: HostMessage }
      hostExit: { key: string; message: string }
    }
  }>
}

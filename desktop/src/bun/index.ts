import { existsSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import Electrobun, {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  BuildConfig,
  Utils,
} from 'electrobun/main'
import { type HostMessage, parseHostCommand } from '../../../src/host/protocol'
import { externalUrl } from '../shared/externalUrl'
import {
  KEYCHAIN_SERVICE,
  PROVIDERS,
  type Provider,
  type SavedSettings,
  hostEnvironment,
  isProvider,
  parseSavedSettings,
  providerSettings,
  validApiKey,
} from '../shared/providers'
import type { DesktopRPC } from '../shared/rpc'

// Build-time path: bundled main code lives inside the app, not desktop/src/bun.
declare const OCTONOESIS_DEV_ENGINE_ROOT: string
const engineRoot = process.env.OCTONOESIS_ENGINE_ROOT || OCTONOESIS_DEV_ENGINE_ROOT
type Child = ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>
/** Live sessions: one engine host process each, keyed by the id the webview addresses. */
const hosts = new Map<string, { child: Child; repoRoot: string }>()
const stopping = new Set<Promise<void>>()
// Repositories the user picked in this window; the webview may only start hosts in these.
const repositories = new Set<string>()
const MAX_SESSIONS = 6
let closing = false
let opening = false
let startupDone = false
// Message types only (never content): OCTONOESIS_DEV_TRACE=1 in a dev build.
let tracing = process.env.OCTONOESIS_DEV_TRACE === '1'
const trace = (...parts: string[]) => {
  if (tracing) console.error('[trace]', ...parts)
}
void BuildConfig.get().then((config) => {
  if (config.isPackaged) tracing = false
})

const settingsFile = join(Utils.paths.userData, 'settings.json')
async function readSettings(): Promise<SavedSettings> {
  try {
    return parseSavedSettings(await Bun.file(settingsFile).json())
  } catch {
    return parseSavedSettings({})
  }
}
async function writeSettings(settings: SavedSettings) {
  await mkdir(Utils.paths.userData, { recursive: true })
  await Bun.write(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
}
async function currentSettings() {
  return providerSettings(await readSettings(), process.env)
}
function provider(value: unknown): Provider {
  if (!isProvider(value)) throw new Error('Unknown provider')
  return value
}

function stopHost(key: string) {
  const host = hosts.get(key)
  if (!host) return Promise.resolve()
  hosts.delete(key)
  const stop = (async () => {
    host.child.kill('SIGTERM')
    const deadline = setTimeout(() => host.child.kill('SIGKILL'), 3000)
    try {
      await host.child.exited
    } finally {
      clearTimeout(deadline)
    }
  })()
  stopping.add(stop)
  void stop.finally(() => stopping.delete(stop))
  return stop
}
const stopAll = () => Promise.all([...hosts.keys()].map(stopHost))

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** One host start or switch at a time; failures become the request's error text. */
type Opened = { opened: boolean; key?: string; error?: string }
async function exclusive(start: () => Promise<Opened>): Promise<Opened> {
  if (closing || opening) return { opened: false }
  opening = true
  try {
    return await start()
  } catch (error) {
    return { opened: false, error: errorText(error) }
  } finally {
    opening = false
  }
}

function knownRepository(root: unknown): string {
  if (typeof root !== 'string' || !repositories.has(root))
    throw new Error('Open this repository first.')
  return root
}

async function startHost(root: string, resumeId?: string): Promise<Opened> {
  if (closing) return { opened: false }
  if (hosts.size >= MAX_SESSIONS)
    throw new Error(`At most ${MAX_SESSIONS} sessions can run at once. Close one first.`)
  const entry = resolve(engineRoot, 'src/host/main.ts')
  if (!existsSync(entry))
    throw new Error(
      `Engine not found at ${entry}. Set OCTONOESIS_ENGINE_ROOT for this development build.`,
    )
  const env = await hostEnvironment(await readSettings(), process.env, Bun.secrets)
  const child = Bun.spawn([process.execPath, entry, ...(resumeId ? ['--resume', resumeId] : [])], {
    cwd: root,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...env, OCTONOESIS_REPO_ROOT: root },
  })
  const key = crypto.randomUUID()
  hosts.set(key, { child, repoRoot: root })
  repositories.add(root)
  const live = () => hosts.get(key)?.child === child
  const relay = async () => {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (live()) {
            const message = JSON.parse(line) as HostMessage
            if (message.v !== 1) throw new Error('Unsupported host protocol')
            trace(
              key.slice(0, 8),
              'host →',
              message.type === 'event' ? `event:${message.event.type}` : message.type,
            )
            rpc.send.host({ key, message })
          }
          newline = buffer.indexOf('\n')
        }
        if (done) break
      }
      if (buffer) throw new Error('Incomplete host protocol line')
    } catch (error) {
      if (live()) rpc.send.hostExit({ key, message: `Host protocol failure: ${String(error)}` })
      child.kill('SIGTERM')
    } finally {
      reader.releaseLock()
    }
  }
  const relayed = relay()
  void (async () => {
    const reader = child.stderr.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        process.stderr.write(value)
      }
    } finally {
      reader.releaseLock()
    }
  })()
  void child.exited.then(async (code) => {
    await relayed
    if (!live()) return
    hosts.delete(key)
    rpc.send.hostExit({
      key,
      message: `Engine exited (${code}). Start a new session to continue.`,
    })
  })
  return { opened: true, key }
}

const rpc = BrowserView.defineRPC<DesktopRPC>({
  maxRequestTime: 15000,
  handlers: {
    requests: {
      openExternal: ({ url }) => {
        const validated = externalUrl(url)
        return { opened: validated ? Utils.openExternal(validated) : false }
      },
      startup: async () => {
        // Development-only launch options let the reviewer screenshot without clicking.
        if (startupDone || (await BuildConfig.get()).isPackaged) return { opened: false }
        startupDone = true
        const screen = process.env.OCTONOESIS_DEV_SCREEN === 'settings' ? 'settings' : undefined
        const panelFlag = process.env.OCTONOESIS_DEV_PANEL
        const panel =
          panelFlag === 'changes' || panelFlag === 'timeline' || panelFlag === 'learning'
            ? panelFlag
            : undefined
        const prompt = process.env.OCTONOESIS_DEV_PROMPT || undefined
        const mode = process.env.OCTONOESIS_DEV_PERMISSION_MODE
        const permissionMode = mode === 'accept-edits' || mode === 'bypass' ? mode : undefined
        const repository = process.env.OCTONOESIS_DEV_OPEN
        if (!repository) return { opened: false, screen, panel }
        const opened = await exclusive(async () => startHost(await realpath(repository)))
        if (!opened.opened) return { ...opened, screen, panel }
        return { ...opened, screen, panel, prompt, permissionMode }
      },
      openRepository: () =>
        exclusive(async () => {
          const paths = await Utils.openFileDialog({
            canChooseFiles: false,
            canChooseDirectory: true,
            allowsMultipleSelection: false,
          })
          if (!paths[0] || closing) return { opened: false }
          return startHost(await realpath(paths[0]))
        }),
      newSession: ({ repoRoot }) => exclusive(async () => startHost(knownRepository(repoRoot))),
      resumeSession: ({ repoRoot, sessionId }) =>
        exclusive(async () => {
          if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sessionId))
            throw new Error('Invalid session id')
          return startHost(knownRepository(repoRoot), sessionId)
        }),
      closeSession: async ({ key }) => {
        if (!hosts.has(key)) return { closed: false }
        await stopHost(key)
        return { closed: true }
      },
      getProviderSettings: () => currentSettings(),
      setProvider: async (params) => {
        const settings = await readSettings()
        await writeSettings({ ...settings, provider: provider(params.provider) })
        return currentSettings()
      },
      saveApiKey: async (params) => {
        const chosen = provider(params.provider)
        try {
          const value = validApiKey(params.key)
          await Bun.secrets.set({
            service: KEYCHAIN_SERVICE,
            name: PROVIDERS[chosen].variable,
            value,
          })
          const settings = await readSettings()
          await writeSettings({
            ...settings,
            storedKeys: [...new Set([...(settings.storedKeys ?? []), chosen])],
          })
          return currentSettings()
        } catch (error) {
          return { ...(await currentSettings()), error: errorText(error) }
        }
      },
      deleteApiKey: async (params) => {
        const chosen = provider(params.provider)
        try {
          await Bun.secrets.delete({ service: KEYCHAIN_SERVICE, name: PROVIDERS[chosen].variable })
          const settings = await readSettings()
          await writeSettings({
            ...settings,
            storedKeys: (settings.storedKeys ?? []).filter((stored) => stored !== chosen),
          })
          return currentSettings()
        } catch (error) {
          return { ...(await currentSettings()), error: errorText(error) }
        }
      },
    },
    messages: {
      command: ({ key, command }) => {
        try {
          const validated = parseHostCommand(JSON.stringify(command))
          const host = hosts.get(key)?.child
          if (!host) throw new Error('This session has ended. Start a new session to continue.')
          trace(key.slice(0, 8), '→ host', validated.type)
          host.stdin.write(`${JSON.stringify(validated)}\n`)
          host.stdin.flush()
        } catch (error) {
          rpc.send.host({ key, message: { v: 1, type: 'error', message: String(error) } })
        }
      },
    },
  },
})
const window = new BrowserWindow({
  title: 'Octonoesis',
  url: 'views://mainview/index.html',
  frame: { width: 1280, height: 820, x: 120, y: 80 },
  rpc,
})

const quit = () => {
  closing = true
  void Promise.all([stopAll(), ...stopping]).then(() => Utils.quit())
}
window.on('will-close', (event) => {
  if (!hosts.size && !stopping.size) return
  ;(event as { response: { allow: boolean } }).response = { allow: false }
  quit()
})
Electrobun.events.on('before-quit', (event) => {
  if (!hosts.size && !stopping.size) return
  event.response = { allow: false }
  quit()
})
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, quit)

ApplicationMenu.setApplicationMenu([
  {
    label: 'Octonoesis',
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'showAll' },
      { type: 'separator' },
      { role: 'quit', label: 'Quit Octonoesis' },
    ],
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' },
    ],
  },
  {
    label: 'Window',
    submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close', label: 'Close Window' }],
  },
])

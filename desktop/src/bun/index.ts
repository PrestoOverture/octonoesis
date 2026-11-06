import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import Electrobun, { ApplicationMenu, BrowserView, BrowserWindow, Utils } from 'electrobun/main'
import { type HostMessage, parseHostCommand } from '../../../src/host/protocol'
import { externalUrl } from '../shared/externalUrl'
import type { DesktopRPC } from '../shared/rpc'

// Build-time path: bundled main code lives inside the app, not desktop/src/bun.
declare const OCTONOESIS_DEV_ENGINE_ROOT: string
const engineRoot = process.env.OCTONOESIS_ENGINE_ROOT || OCTONOESIS_DEV_ENGINE_ROOT
let host: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>> | undefined
let closing = false
let opening = false
let stopping: Promise<void> | undefined

function stopHost() {
  if (stopping) return stopping
  const child = host
  if (!child) return Promise.resolve()
  host = undefined
  stopping = (async () => {
    child.kill('SIGTERM')
    const deadline = setTimeout(() => child.kill('SIGKILL'), 3000)
    try {
      await child.exited
    } finally {
      clearTimeout(deadline)
      stopping = undefined
    }
  })()
  return stopping
}

const rpc = BrowserView.defineRPC<DesktopRPC>({
  maxRequestTime: 15000,
  handlers: {
    requests: {
      openExternal: ({ url }) => {
        const validated = externalUrl(url)
        return { opened: validated ? Utils.openExternal(validated) : false }
      },
      openRepository: async () => {
        if (closing || opening) return { opened: false }
        opening = true
        try {
          const paths = await Utils.openFileDialog({
            canChooseFiles: false,
            canChooseDirectory: true,
            allowsMultipleSelection: false,
          })
          if (!paths[0] || closing) return { opened: false }
          await stopHost()
          if (closing) return { opened: false }
          const repoRoot = await realpath(paths[0])
          const entry = resolve(engineRoot, 'src/host/main.ts')
          if (!existsSync(entry))
            throw new Error(
              `Engine not found at ${entry}. Set OCTONOESIS_ENGINE_ROOT for this development build.`,
            )
          const child = Bun.spawn([process.execPath, entry], {
            cwd: repoRoot,
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env, OCTONOESIS_REPO_ROOT: repoRoot },
          })
          host = child
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
                  if (host === child) {
                    const message = JSON.parse(line) as HostMessage
                    if (message.v !== 1) throw new Error('Unsupported host protocol')
                    rpc.send.host(message)
                  }
                  newline = buffer.indexOf('\n')
                }
                if (done) break
              }
              if (buffer) throw new Error('Incomplete host protocol line')
            } catch (error) {
              if (host === child)
                rpc.send.hostExit({ message: `Host protocol failure: ${String(error)}` })
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
            if (host !== child) return
            host = undefined
            rpc.send.hostExit({
              message: `Engine exited (${code}). Open a repository to start a new session.`,
            })
          })
          return { opened: true }
        } catch (error) {
          return { opened: false, error: String(error) }
        } finally {
          opening = false
        }
      },
    },
    messages: {
      command: (command) => {
        try {
          const validated = parseHostCommand(JSON.stringify(command))
          if (!host) throw new Error('No active engine. Open a repository to reconnect.')
          host.stdin.write(`${JSON.stringify(validated)}\n`)
          host.stdin.flush()
        } catch (error) {
          rpc.send.host({ v: 1, type: 'error', message: String(error) })
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
  void stopHost().then(() => Utils.quit())
}
window.on('will-close', (event) => {
  if (!host && !stopping) return
  ;(event as { response: { allow: boolean } }).response = { allow: false }
  quit()
})
Electrobun.events.on('before-quit', (event) => {
  if (!host && !stopping) return
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

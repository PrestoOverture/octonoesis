// Bundles the engine host into engine/ for packaged builds: one JS file run by the app's own
// Bun, plus this platform's ripgrep where @vscode/ripgrep resolves it from the bundle.
import { existsSync } from 'node:fs'
import { cp, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const out = fileURLToPath(new URL('../engine/', import.meta.url))
const ripgrep = `@vscode/ripgrep-${process.platform}-${process.arch}`
const ripgrepSource = `${root}node_modules/${ripgrep}`
if (!existsSync(`${ripgrepSource}/bin/rg`))
  throw new Error(`Missing ${ripgrep}; run bun install in the repository root first.`)

await rm(out, { recursive: true, force: true })
const result = await Bun.build({
  entrypoints: [`${root}src/host/main.ts`],
  target: 'bun',
  outdir: out,
  naming: 'host.js',
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
await mkdir(`${out}node_modules/@vscode`, { recursive: true })
await cp(ripgrepSource, `${out}node_modules/${ripgrep}`, { recursive: true })
console.log(`engine bundled: ${out}host.js + ${ripgrep}`)

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
let target: string | undefined
let outfile = 'dist/agent'
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if ((arg !== '--target' && arg !== '--outfile') || !args[i + 1]) {
    throw new Error('Usage: bun scripts/build-bin.ts [--target <bun-target>] [--outfile <path>]')
  }
  const value = args[++i] as string
  if (arg === '--target') target = value
  else outfile = value
}

const match = target?.match(/^bun-(darwin|linux|windows)-(arm64|x64)(?:-.*)?$/)
if (target && !match) throw new Error(`Unsupported Bun target: ${target}`)
const platform = match ? (match[1] === 'windows' ? 'win32' : match[1]) : process.platform
const arch = match ? match[2] : process.arch
const rgPath = resolve(
  root,
  `node_modules/@vscode/ripgrep-${platform}-${arch}/bin/${platform === 'win32' ? 'rg.exe' : 'rg'}`,
)
if (!existsSync(rgPath)) {
  throw new Error(
    `Missing ripgrep binary: ${rgPath}. Install optional dependencies for ${platform}-${arch}.`,
  )
}

function run(command: string, argv: string[]): void {
  const result = spawnSync(command, argv, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const output = resolve(process.cwd(), outfile)
run(process.execPath, [
  'build',
  'src/cli.tsx',
  rgPath,
  '--compile',
  ...(target ? [`--target=${target}`] : []),
  '--asset-naming=[name].[ext]',
  '--outfile',
  output,
])
if (process.platform === 'darwin' && platform === 'darwin') {
  run('codesign', ['--force', '--sign', '-', output])
  run('codesign', ['--verify', '--strict', output])
}

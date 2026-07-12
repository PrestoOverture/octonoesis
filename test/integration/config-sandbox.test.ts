import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clearConfigCacheForTests, loadConfig } from '../../src/config/load'
import { resolveSandboxConfig } from '../../src/sandbox/manager'
import { bashTool } from '../../src/tools/Bash'

const describeDarwin = (
  describe as typeof describe & { skipIf: (condition: boolean) => typeof describe }
).skipIf(process.platform !== 'darwin')
const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
let root = ''

afterEach(async () => {
  if (originalMemoryDir === undefined) Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
  else process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
  clearConfigCacheForTests()
  if (root) await rm(root, { recursive: true, force: true })
})

describeDarwin('config sandbox ledger protection', () => {
  test('denies writes to a relocated OCTONOESIS_MEMORY_DIR inside the writable repo', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'config-sandbox-'))
    const ledgerDir = path.join(root, '.relocated-ledger')
    const journalPath = path.join(ledgerDir, 'journal.jsonl')
    await mkdir(ledgerDir, { recursive: true })
    await mkdir(path.join(root, '.octonoesis'), { recursive: true })
    await writeFile(journalPath, 'original\n')
    await writeFile(
      path.join(root, '.octonoesis', 'config.json'),
      JSON.stringify({ sandbox: { enabled: true } }),
    )
    process.env.OCTONOESIS_MEMORY_DIR = ledgerDir
    const config = await loadConfig(root)
    const sandbox = resolveSandboxConfig({ repoRoot: root, config: config.sandbox })
    expect(sandbox.enabled).toBe(true)

    const result = await bashTool.call(
      { command: `printf tampered >> '${journalPath}'` },
      { repoRoot: root, sandbox },
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(JSON.parse(result.value).code).not.toBe(0)
    expect(await readFile(journalPath, 'utf8')).toBe('original\n')
  })
})

import { expect, test } from 'bun:test'
import { buildDynamicSuffix } from '../../../src/prompts/dynamic'
import { getRepoRoot } from '../../../src/query'

// biome-ignore lint/suspicious/noExplicitAny: global environment type bypass
declare const Bun: any

test('buildDynamicSuffix generates correct prompt block including OS, Shell, CWD, Time, Bun/Node version, Git status, Model, and Usage', async () => {
  const originalSpawn = Bun.spawn
  let spawnCalled = false

  Bun.spawn = (args: string[]) => {
    spawnCalled = true
    expect(args).toEqual(['git', 'status', '--porcelain'])
    return {
      stdout: new Blob(['M src/prompts/dynamic.ts\n?? test/unit/prompts/dynamic.test.ts']).stream(),
      stderr: new Blob(['']).stream(),
      exited: Promise.resolve(0),
    }
  }

  try {
    const ctx = { repoRoot: getRepoRoot() }
    const model = 'test-model'
    const usage = { input_tokens: 123, output_tokens: 456 }

    const result = await buildDynamicSuffix(ctx, model, usage)

    expect(spawnCalled).toBe(true)
    expect(result).toContain('## Runtime Environment')
    expect(result).toContain('- **Operating System**')
    expect(result).toContain('- **Shell**')
    expect(result).toContain('- **Current Directory**')
    expect(result).toContain('- **Current Time**')
    expect(result).toContain('- **Bun Version**')
    expect(result).toContain('- **Node Version**')
    expect(result).toContain('- **Git Status**')
    expect(result).toContain('M src/prompts/dynamic.ts')
    expect(result).toContain('?? test/unit/prompts/dynamic.test.ts')
    expect(result).toContain('- **Active Model**: test-model')
    expect(result).toContain('- **Cumulative Tokens**: Input: 123, Output: 456')
  } finally {
    Bun.spawn = originalSpawn
  }
})

test('buildDynamicSuffix handles git status failure gracefully', async () => {
  const originalSpawn = Bun.spawn
  Bun.spawn = () => {
    throw new Error('git error')
  }

  try {
    const ctx = { repoRoot: getRepoRoot() }
    const model = 'test-model'
    const usage = { input_tokens: 123, output_tokens: 456 }

    const result = await buildDynamicSuffix(ctx, model, usage)
    expect(result).toContain('no git')
  } finally {
    Bun.spawn = originalSpawn
  }
})

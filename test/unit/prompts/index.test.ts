import { expect, test } from 'bun:test'
import { buildSystemMessages } from '../../../src/prompts/index'
import { getRepoRoot } from '../../../src/query'

test('buildSystemMessages aggregates both static and dynamic prompt sections', async () => {
  const ctx = { repoRoot: getRepoRoot() }
  const model = 'test-model'
  const usage = { input_tokens: 10, output_tokens: 20 }

  const result = await buildSystemMessages(ctx, model, usage)
  expect(result.system).toContain('You are Octonoesis')
  expect(result.dynamicSystem).toContain('## Runtime Environment')
  expect(result.dynamicSystem).toContain('test-model')
  expect(result.dynamicSystem).toContain('Input: 10, Output: 20')
})

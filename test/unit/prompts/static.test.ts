import { expect, test } from 'bun:test'
import { buildStaticPrompt } from '../../../src/prompts/static'

test('static prompt is byte-identical across multiple invocations', () => {
  const run1 = buildStaticPrompt()
  const run2 = buildStaticPrompt()

  expect(run1).toBe(run2)
  expect(run1).toContain('You are Octonoesis')
  expect(run1).toContain('## Doing Tasks & Philosophy')
  expect(run1).toContain('## Using Your Tools')
  expect(run1).toContain('## Safety Rules')
  expect(run1).toContain('## Tone and Style')
  expect(run1).toContain('## Available Tools')
  expect(run1).toContain('Read')
  expect(run1).toContain('Write')
  expect(run1).toContain('Edit')
  expect(run1).toContain('Bash')
})

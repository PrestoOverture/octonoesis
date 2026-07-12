import { afterEach, describe, expect, test } from 'bun:test'
import { parseConfig } from '../../../src/config/schema'
import {
  registerPromptHandler,
  requestPermission,
  unregisterPromptHandler,
} from '../../../src/permissions/confirm'

afterEach(() => unregisterPromptHandler())

describe('config permission patterns', () => {
  test('matches bare tool names and Bash command prefixes', async () => {
    let prompts = 0
    registerPromptHandler(async () => {
      prompts++
      return 'allow_once'
    })
    const config = parseConfig({
      permissions: { allowPatterns: ['Edit', 'Bash(git status*)'] },
    })
    const ctx = { repoRoot: '/not-a-repository', config }

    expect(await requestPermission('Edit', { path: 'src/a.ts' }, ctx)).toBe('allow_always')
    expect(await requestPermission('Bash', { command: 'git status --short' }, ctx)).toBe(
      'allow_always',
    )
    expect(await requestPermission('Bash', { command: 'git diff' }, ctx)).toBe('allow_once')
    expect(prompts).toBe(1)
  })

  test('deny patterns beat allow patterns without prompting', async () => {
    let prompted = false
    registerPromptHandler(async () => {
      prompted = true
      return 'allow_once'
    })
    const config = parseConfig({
      permissions: {
        allowPatterns: ['Bash(rm*)'],
        denyPatterns: ['Bash(rm -rf*)'],
      },
    })

    expect(
      await requestPermission('Bash', { command: 'rm -rf build' }, { repoRoot: '/tmp', config }),
    ).toBe('deny')
    expect(prompted).toBe(false)
  })
})

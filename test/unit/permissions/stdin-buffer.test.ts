import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { PassThrough } from 'node:stream'
import {
  clearAllowlist,
  getBufferedPermissionLineCountForTests,
  requestPermission,
  setPermissionInputStreamForTests,
  unregisterPromptHandler,
} from '../../../src/permissions/confirm'

beforeEach(() => {
  clearAllowlist()
  unregisterPromptHandler()
  setPermissionInputStreamForTests()
})

afterEach(() => {
  clearAllowlist()
  unregisterPromptHandler()
  setPermissionInputStreamForTests()
})

describe('one-shot permission stdin buffering', () => {
  it('bounds lines already emitted in the chunk after satisfying a pending prompt', async () => {
    const input = new PassThrough()
    setPermissionInputStreamForTests(input)
    const permission = requestPermission('Write', { path: 'bounded.txt' })
    input.end(`${Array.from({ length: 10_000 }, () => 'y').join('\n')}\n`)

    expect(await permission).toBe('allow_once')
    expect(getBufferedPermissionLineCountForTests() <= 32).toBe(true)
    expect(input.isPaused()).toBe(true)
  })
})

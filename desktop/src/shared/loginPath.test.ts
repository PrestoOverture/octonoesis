import { expect, test } from 'bun:test'
import { loginShellPath, parseShellPath, shellCommand } from './loginPath'

test('the PATH is read between markers, ignoring rc-file noise', () => {
  expect(
    parseShellPath('Welcome!\n__OCTONOESIS_PATH__/opt/homebrew/bin:/usr/bin__OCTONOESIS_PATH__'),
  ).toBe('/opt/homebrew/bin:/usr/bin')
  expect(parseShellPath('no markers here')).toBeUndefined()
  expect(parseShellPath('__OCTONOESIS_PATH____OCTONOESIS_PATH__')).toBeUndefined()
  expect(parseShellPath('__OCTONOESIS_PATH__/usr/bin')).toBeUndefined()
})

test('only an absolute SHELL is run; anything else falls back to zsh', () => {
  expect(shellCommand('/bin/bash')[0]).toBe('/bin/bash')
  expect(shellCommand('bash; rm -rf ~')[0]).toBe('/bin/zsh')
  expect(shellCommand(undefined)[0]).toBe('/bin/zsh')
  expect(shellCommand('/bin/sh').slice(1, 2)).toEqual(['-ilc'])
})

test('a login shell reports its PATH; a failing shell yields undefined', async () => {
  expect(await loginShellPath('/bin/sh')).toContain('/')
  expect(await loginShellPath('/usr/bin/false')).toBeUndefined()
  expect(await loginShellPath('/nonexistent/shell')).toBeUndefined()
})

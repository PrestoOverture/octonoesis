import { expect, test } from 'bun:test'
import { externalUrl } from './externalUrl'

test('openExternal boundary accepts and normalizes only absolute HTTP/HTTPS URLs', () => {
  expect(externalUrl('https://example.com/a?q=1#x')).toBe('https://example.com/a?q=1#x')
  expect(externalUrl('HTTP://EXAMPLE.COM')).toBe('http://example.com/')
  for (const value of [
    'javascript:alert(1)',
    'java\nscript:alert(1)',
    'file:///tmp/a',
    'data:text/html,hi',
    'mailto:a@example.com',
    'views://mainview/index.html',
    '/relative',
    '//example.com',
    '',
    'https://',
    null,
    {},
    1,
  ])
    expect(externalUrl(value)).toBeUndefined()
})

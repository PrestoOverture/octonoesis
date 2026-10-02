import { afterEach, beforeEach, expect, test } from 'bun:test'
import chalk from 'chalk'
import { renderMarkdown } from '../../src/ui/markdown'

declare const Bun: { stringWidth(text: string): number }
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal style sequences
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')
let level: typeof chalk.level
beforeEach(() => {
  level = chalk.level
  chalk.level = 1
})
afterEach(() => {
  chalk.level = level
})

test('inline emphasis and codespan remove markers and apply styles', () => {
  const output = renderMarkdown('**bold** *italic* `code`')
  expect(strip(output)).toBe('bold italic code\n')
  expect(output).toContain(chalk.bold('bold'))
  expect(output).toContain(chalk.italic('italic'))
  expect(output).toContain(chalk.cyan('code'))
})

test('headings are bold, h1 is colored and underlined, with blank lines', () => {
  const output = renderMarkdown('# Title\n## Subtitle')
  expect(strip(output)).toBe('Title\n\nSubtitle\n\n')
  expect(output).toContain(chalk.cyan.underline(chalk.bold('Title')))
  expect(output).toContain(chalk.bold('Subtitle'))
})

test('nested, ordered and task lists retain hierarchy', () => {
  expect(strip(renderMarkdown('- outer\n  - inner\n    1. ordered\n    2. next\n- end'))).toBe(
    '• outer\n  • inner\n    1. ordered\n    2. next\n• end\n',
  )
  expect(strip(renderMarkdown('3. three\n4. four'))).toBe('3. three\n4. four\n')
  expect(strip(renderMarkdown('- [ ] pending\n- [x] done'))).toBe('☐ pending\n☑ done\n')
})

test('fenced code is verbatim, indented and styled', () => {
  const output = renderMarkdown('```ts\n**x**\n  y\n```')
  expect(strip(output)).toBe('  **x**\n    y\n')
  expect(output).toContain(chalk.dim.cyan('  **x**\n    y'))
})

test('links show their destinations without duplicating URL labels', () => {
  expect(strip(renderMarkdown('[site](https://example.com)'))).toBe('site (https://example.com)\n')
  expect(strip(renderMarkdown('<https://example.com>'))).toBe('https://example.com\n')
  expect(strip(renderMarkdown('[https://example.com](https://example.com)'))).toBe(
    'https://example.com\n',
  )
})

test('CJK table columns align by terminal display width', () => {
  const output = renderMarkdown('| 名称 | Value |\n| :--- | ---: |\n| **中文** | 1 |\n| a | 100 |')
  const lines = strip(output).trimEnd().split('\n')
  expect(new Set(lines.map((line) => Bun.stringWidth(line))).size).toBe(1)
  const columns = lines.map((line) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => Bun.stringWidth(cell)),
  )
  for (const row of columns) expect(row).toEqual(columns[0])
  expect(output).toContain(chalk.bold(lines[0] ?? ''))
})

test('approximate quantities, unclosed emphasis and empty input are safe', () => {
  expect(strip(renderMarkdown('~100 ~~literal~~'))).toBe('~100 ~~literal~~\n')
  expect(() => renderMarkdown('**bold')).not.toThrow()
  expect(strip(renderMarkdown('**bold'))).toContain('**bold')
  expect(renderMarkdown('')).toBe('')
})

test('quotes, breaks, escapes, html and horizontal rules', () => {
  expect(strip(renderMarkdown('> quoted'))).toBe('│ quoted\n')
  expect(strip(renderMarkdown('a  \nb'))).toBe('a\nb\n')
  expect(strip(renderMarkdown('\\*literal\\*'))).toBe('*literal*\n')
  expect(strip(renderMarkdown('<b>html</b>'))).toContain('<b>html</b>')
  expect(strip(renderMarkdown('---'))).toBe(`${'─'.repeat(40)}\n`)
})

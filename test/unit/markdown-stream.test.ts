import { afterEach, beforeEach, expect, test } from 'bun:test'
import chalk from 'chalk'
import { createMarkdownStream, renderMarkdown } from '../../src/ui/markdown'

let level: typeof chalk.level
beforeEach(() => {
  level = chalk.level
  chalk.level = 1
})
afterEach(() => {
  chalk.level = level
})

test('one-shot split tokens render identically to the complete run on a TTY', () => {
  const deltas = ['**bo', 'ld** text\n\n- a', '\n- b']
  let output = ''
  const stream = createMarkdownStream((text) => {
    output += text
  }, true)
  stream.write(deltas[0] ?? '')
  expect(output).toBe('')
  for (const delta of deltas.slice(1)) stream.write(delta)
  expect(output).toContain(chalk.bold('bold'))
  expect(output).not.toContain('• a') // final list remains pending
  stream.flush()
  expect(output).toBe(renderMarkdown(deltas.join('')))
  stream.flush()
  expect(output).toBe(renderMarkdown(deltas.join('')))
})

test('one-shot piped deltas stay byte-identical and immediate', () => {
  const deltas = ['**bo', 'ld** text\n\n- a', '\n- b']
  let output = ''
  const stream = createMarkdownStream((text) => {
    output += text
  }, false)
  for (let index = 0; index < deltas.length; index++) {
    stream.write(deltas[index] ?? '')
    expect(output).toBe(deltas.slice(0, index + 1).join(''))
  }
  stream.flush()
  expect(output).toBe(deltas.join(''))
})

test('flushing ends a text run before a tool call or message boundary', () => {
  let output = ''
  const stream = createMarkdownStream((text) => {
    output += text
  }, true)
  stream.write('**before**')
  stream.flush()
  output += '[Tool Call]\n'
  stream.write('*after*')
  stream.flush()
  expect(output).toBe(`${renderMarkdown('**before**')}[Tool Call]\n${renderMarkdown('*after*')}`)
})

test('mixed-block spacing stays equivalent across streaming boundaries', () => {
  const input =
    '## 标题\n\n一段 **粗体** 话。\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```bash\necho hi\n```\n\n结尾段落。'
  for (const size of [1, 3, 10, input.length]) {
    let output = ''
    const stream = createMarkdownStream((text) => {
      output += text
    }, true)
    for (let offset = 0; offset < input.length; offset += size) {
      stream.write(input.slice(offset, offset + size))
    }
    stream.flush()
    expect(output).toBe(renderMarkdown(input))
  }
})

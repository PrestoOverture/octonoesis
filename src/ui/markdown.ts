import chalk from 'chalk'
import { type Token, type Tokens, marked } from 'marked'

declare const Bun: { stringWidth(text: string): number }

// Keep approximate quantities and literal tildes intact.
const lexerOptions = { gfm: true, tokenizer: new marked.Tokenizer() }
lexerOptions.tokenizer.del = () => undefined

export function lexMarkdown(text: string): Token[] {
  return marked.lexer(text, lexerOptions)
}

function inline(tokens: Token[] | undefined): string {
  return (tokens ?? []).map((token) => formatToken(token)).join('')
}

function formatToken(token: Token, depth = 0): string {
  switch (token.type) {
    case 'strong':
      return chalk.bold(inline(token.tokens))
    case 'em':
      return chalk.italic(inline(token.tokens))
    case 'codespan':
      return chalk.cyan(token.text)
    case 'heading': {
      const text = chalk.bold(inline(token.tokens))
      return `${token.depth === 1 ? chalk.cyan.underline(text) : text}\n`
    }
    case 'paragraph':
      return `${inline(token.tokens)}\n`
    case 'text':
      return token.tokens ? inline(token.tokens) : token.text
    case 'escape':
    case 'html':
      return token.text
    case 'space':
      return '\n'
    case 'br':
      return '\n'
    case 'code':
      return `${chalk.dim.cyan(
        token.text
          .split('\n')
          .map((line: string) => `  ${line}`)
          .join('\n'),
      )}\n`
    case 'blockquote':
      return `${chalk.dim(
        inline(token.tokens)
          .replace(/\n$/, '')
          .split('\n')
          .map((line) => `│ ${line}`)
          .join('\n'),
      )}\n`
    case 'link': {
      const text = inline(token.tokens)
      return text === token.href ? token.href : `${text} (${token.href})`
    }
    case 'image':
      return `${token.text} (${token.href})`
    case 'list':
      return token.items
        .map((item: Tokens.ListItem, index: number) => {
          const marker = item.task
            ? item.checked
              ? '☑'
              : '☐'
            : token.ordered
              ? `${Number(token.start) + index}.`
              : '•'
          const indent = '  '.repeat(depth)
          const content = item.tokens
            .filter((child) => child.type !== 'checkbox')
            .map((child) => {
              if (child.type === 'list') return `\n${formatToken(child, depth + 1)}`
              return formatToken(child, depth + 1)
            })
            .join('')
            .replace(/\n+$/, '')
          return `${indent}${marker} ${content}\n`
        })
        .join('')
    case 'table': {
      const table = token as Tokens.Table
      const rows = [table.header, ...table.rows].map((row) =>
        row.map((cell) => inline(cell.tokens)),
      )
      const widths = table.header.map((_, index) =>
        Math.max(3, ...rows.map((row) => Bun.stringWidth(row[index] ?? ''))),
      )
      const rowText = (row: string[]) =>
        `| ${widths
          .map((width, index) => {
            const text = row[index] ?? ''
            const padding = width - Bun.stringWidth(text)
            const align = table.align[index]
            const left =
              align === 'right' ? padding : align === 'center' ? Math.floor(padding / 2) : 0
            return ' '.repeat(left) + text + ' '.repeat(padding - left)
          })
          .join(' | ')} |\n`
      return `${chalk.bold(rowText(rows[0] ?? []))}|${widths.map((width) => '─'.repeat(width + 2)).join('|')}|\n${rows.slice(1).map(rowText).join('')}`
    }
    case 'hr':
      return `${'─'.repeat(40)}\n`
    default:
      return token.raw
  }
}

/** Terminal presentation only; malformed input or renderer errors preserve the source. */
export function renderMarkdown(text: string): string {
  try {
    return lexMarkdown(text)
      .map((token) => formatToken(token))
      .join('')
  } catch {
    return text
  }
}

/** Raw stable prefix shared by the one-shot writer and the pure display reducer. */
export function stableMarkdownLength(text: string): number {
  try {
    const tokens = lexMarkdown(text)
    return tokens.slice(0, -1).reduce((sum, token) => sum + token.raw.length, 0)
  } catch {
    return 0
  }
}

/** Commit complete top-level tokens while retaining the mutable trailing token. */
export function createMarkdownStream(write: (text: string) => void, isTTY: boolean) {
  let pending = ''
  return {
    write(delta: string) {
      if (!isTTY) {
        write(delta)
        return
      }
      pending += delta
      const length = stableMarkdownLength(pending)
      if (length) {
        write(renderMarkdown(pending.slice(0, length)))
        pending = pending.slice(length)
      }
    },
    flush() {
      if (pending) write(renderMarkdown(pending))
      pending = ''
    },
  }
}

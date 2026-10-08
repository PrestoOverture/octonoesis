import { stripVTControlCharacters } from 'node:util'

declare const Bun: {
  stringWidth(text: string): number
  wrapAnsi(text: string, width: number, options: { trim: boolean; hard: boolean }): string
}

/** Keep explicit indentation/newlines; trim spaces only at soft prose breaks. */
export function wrapAssistant(text: string, columns: number): string {
  const width = Math.max(1, columns)
  return text
    .split('\n')
    .map((line) => {
      const indent = stripVTControlCharacters(line).match(/^[ \t]+/)?.[0] ?? ''
      if (!indent) return Bun.wrapAnsi(line, width, { trim: true, hard: true })
      // Bun's trim also removes explicit indentation. Reserve and restore it on
      // the first physical row; continuation rows need no artificial indentation.
      const prefix = Bun.wrapAnsi(indent, width, { trim: false, hard: true })
      const lastIndentWidth = Bun.stringWidth(prefix.split('\n').at(-1) ?? '')
      const wrapped = Bun.wrapAnsi(line, Math.max(1, width - lastIndentWidth), {
        trim: true,
        hard: true,
      })
      return `${prefix}${lastIndentWidth >= width && wrapped ? '\n' : ''}${wrapped}`
    })
    .join('\n')
}

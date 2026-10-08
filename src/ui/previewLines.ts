declare const Bun: { stringWidth(text: string): number }

/** Wrap before budgeting so terminal wrapping cannot silently hide approval content. */
export function wrapPreviewLines(text: string, columns: number): string[] {
  const width = Math.max(1, columns)
  return text.split('\n').flatMap((line) => {
    const lines: string[] = []
    let current = ''
    let used = 0
    for (const character of line.replace(/\t/g, '    ')) {
      const size = Bun.stringWidth(character)
      if (used + size > width && current) {
        lines.push(current)
        current = ''
        used = 0
      }
      current += character
      used += size
    }
    lines.push(current)
    return lines
  })
}

/** Prose breaks at spaces; only an overlong word is split into character rows. */
export function wrapProseLines(text: string, columns: number): string[] {
  const width = Math.max(1, columns)
  return text.split('\n').flatMap((line) => {
    const rows: string[] = []
    let current = ''
    for (const word of line.split(/\s+/).filter(Boolean)) {
      if (current && Bun.stringWidth(`${current} ${word}`) <= width) {
        current += ` ${word}`
        continue
      }
      if (current) rows.push(current)
      const pieces = wrapPreviewLines(word, width)
      rows.push(...pieces.slice(0, -1))
      current = pieces.at(-1) ?? ''
    }
    rows.push(current)
    return rows
  })
}

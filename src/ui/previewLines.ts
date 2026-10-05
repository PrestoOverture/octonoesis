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

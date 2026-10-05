/** Scroll existing screen contents into scrollback, then clear from the home cursor. */
export function prepareScreenSequence(rows: number | undefined): string {
  const height = rows === undefined || rows <= 0 ? 24 : rows
  return `${'\n'.repeat(height - 1)}\x1b[H\x1b[0J`
}

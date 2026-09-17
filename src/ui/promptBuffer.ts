export interface PromptBuffer {
  text: string
  cursor: number
}

export interface PromptKey {
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  return?: boolean
  meta?: boolean
  ctrl?: boolean
  backspace?: boolean
  delete?: boolean
  tab?: boolean
  eventType?: 'press' | 'repeat' | 'release'
}

export type PromptInputAction =
  | { type: 'edit'; buffer: PromptBuffer }
  | { type: 'submit'; value: string }
  | { type: 'history'; direction: 'older' | 'newer' }
  | { type: 'none'; buffer: PromptBuffer }

/**
 * Creates a bounded PromptBuffer with text and cursor index clamped within text length.
 *
 * @param text - Initial buffer text (defaults to empty string)
 * @param cursor - Cursor character index (defaults to text end)
 * @returns Initialized PromptBuffer
 */
export function createPromptBuffer(text = '', cursor = text.length): PromptBuffer {
  return { text, cursor: Math.max(0, Math.min(cursor, text.length)) }
}

/**
 * Constructs an edit action payload with a newly created prompt buffer.
 *
 * @param text - Updated prompt text
 * @param cursor - Target cursor position
 * @returns PromptInputAction representing an edit
 */
function edit(text: string, cursor: number): PromptInputAction {
  return { type: 'edit', buffer: createPromptBuffer(text, cursor) }
}

/**
 * Calculates new cursor index when navigating vertically within a multiline buffer.
 *
 * @param buffer - Current prompt buffer
 * @param direction - Direction to move ('up' or 'down')
 * @returns Updated cursor character index
 */
function moveVertically(buffer: PromptBuffer, direction: 'up' | 'down'): number {
  const { text, cursor } = buffer
  const lineStart = text.lastIndexOf('\n', cursor - 1) + 1
  const nextBreak = text.indexOf('\n', cursor)
  const lineEnd = nextBreak === -1 ? text.length : nextBreak
  const column = cursor - lineStart

  if (direction === 'up') {
    if (lineStart === 0) return cursor
    const previousEnd = lineStart - 1
    const previousStart = text.lastIndexOf('\n', previousEnd - 1) + 1
    return previousStart + Math.min(column, previousEnd - previousStart)
  }
  if (lineEnd === text.length) return cursor
  const followingStart = lineEnd + 1
  const followingBreak = text.indexOf('\n', followingStart)
  const followingEnd = followingBreak === -1 ? text.length : followingBreak
  return followingStart + Math.min(column, followingEnd - followingStart)
}

/**
 * Processes a keystroke or text input event against the current prompt buffer.
 *
 * Supports multiline editing (Meta+Enter or trailing backslash-newline), cursor navigation,
 * single-line history navigation, character deletion, and submission.
 *
 * @param buffer - Current prompt buffer
 * @param input - Raw input characters
 * @param key - Structured key event details
 * @returns PromptInputAction describing the resulting state modification or action
 */
export function applyPromptInput(
  buffer: PromptBuffer,
  input: string,
  key: PromptKey,
): PromptInputAction {
  if (key.eventType === 'release') return { type: 'none', buffer }
  if (key.return) {
    if (key.meta) {
      return edit(
        `${buffer.text.slice(0, buffer.cursor)}\n${buffer.text.slice(buffer.cursor)}`,
        buffer.cursor + 1,
      )
    }
    const lineEndsAtCursor =
      buffer.cursor === buffer.text.length || buffer.text[buffer.cursor] === '\n'
    if (lineEndsAtCursor && buffer.text[buffer.cursor - 1] === '\\') {
      return edit(
        `${buffer.text.slice(0, buffer.cursor - 1)}\n${buffer.text.slice(buffer.cursor)}`,
        buffer.cursor,
      )
    }
    return { type: 'submit', value: buffer.text }
  }
  if (key.leftArrow) return edit(buffer.text, buffer.cursor - 1)
  if (key.rightArrow) return edit(buffer.text, buffer.cursor + 1)
  if (key.upArrow) {
    return buffer.text.includes('\n')
      ? edit(buffer.text, moveVertically(buffer, 'up'))
      : { type: 'history', direction: 'older' }
  }
  if (key.downArrow) {
    return buffer.text.includes('\n')
      ? edit(buffer.text, moveVertically(buffer, 'down'))
      : { type: 'history', direction: 'newer' }
  }
  if (key.backspace) {
    if (buffer.cursor === 0) return { type: 'none', buffer }
    return edit(
      `${buffer.text.slice(0, buffer.cursor - 1)}${buffer.text.slice(buffer.cursor)}`,
      buffer.cursor - 1,
    )
  }
  if (key.delete) {
    if (buffer.cursor >= buffer.text.length) return { type: 'none', buffer }
    return edit(
      `${buffer.text.slice(0, buffer.cursor)}${buffer.text.slice(buffer.cursor + 1)}`,
      buffer.cursor,
    )
  }
  if (key.ctrl || key.meta || key.tab) return { type: 'none', buffer }
  if (!input) return { type: 'none', buffer }
  return edit(
    `${buffer.text.slice(0, buffer.cursor)}${input}${buffer.text.slice(buffer.cursor)}`,
    buffer.cursor + input.length,
  )
}

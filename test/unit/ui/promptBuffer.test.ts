import { describe, expect, it } from 'bun:test'
import { applyPromptInput, createPromptBuffer } from '../../../src/ui/promptBuffer.ts'

const noKey = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  return: false,
  meta: false,
  ctrl: false,
  backspace: false,
  delete: false,
  tab: false,
}

describe('prompt buffer', () => {
  it('inserts pasted newlines and traverses across them with Left/Right', () => {
    const inserted = applyPromptInput(createPromptBuffer('ad', 1), 'b\nc', noKey)
    expect(inserted).toEqual({
      type: 'edit',
      buffer: { text: 'ab\ncd', cursor: 4 },
    })

    const left = applyPromptInput(createPromptBuffer('ab\ncd', 3), '', {
      ...noKey,
      leftArrow: true,
    })
    expect(left).toEqual({ type: 'edit', buffer: { text: 'ab\ncd', cursor: 2 } })
    const right = applyPromptInput(createPromptBuffer('ab\ncd', 2), '', {
      ...noKey,
      rightArrow: true,
    })
    expect(right).toEqual({ type: 'edit', buffer: { text: 'ab\ncd', cursor: 3 } })
  })

  it('moves vertically with clamped columns and joins lines on Backspace', () => {
    const text = 'abcd\nx\nxyz'
    const downToShortLine = applyPromptInput(createPromptBuffer(text, 3), '', {
      ...noKey,
      downArrow: true,
    })
    expect(downToShortLine).toEqual({ type: 'edit', buffer: { text, cursor: 6 } })
    const downToThirdLine = applyPromptInput(createPromptBuffer(text, 6), '', {
      ...noKey,
      downArrow: true,
    })
    expect(downToThirdLine).toEqual({ type: 'edit', buffer: { text, cursor: 8 } })
    const backUp = applyPromptInput(createPromptBuffer(text, 8), '', { ...noKey, upArrow: true })
    expect(backUp).toEqual({ type: 'edit', buffer: { text, cursor: 6 } })

    const joined = applyPromptInput(createPromptBuffer(text, 5), '', { ...noKey, backspace: true })
    expect(joined).toEqual({
      type: 'edit',
      buffer: { text: 'abcdx\nxyz', cursor: 4 },
    })
  })

  it('maps Enter, continuation Enter, Alt+Enter, and single-line history arrows', () => {
    const continuation = applyPromptInput(createPromptBuffer('first line\\'), '', {
      ...noKey,
      return: true,
    })
    expect(continuation).toEqual({
      type: 'edit',
      buffer: { text: 'first line\n', cursor: 11 },
    })

    const submit = applyPromptInput(createPromptBuffer('first\nsecond'), '', {
      ...noKey,
      return: true,
    })
    expect(submit).toEqual({ type: 'submit', value: 'first\nsecond' })

    const altEnter = applyPromptInput(createPromptBuffer('abcd', 2), '', {
      ...noKey,
      return: true,
      meta: true,
    })
    expect(altEnter).toEqual({
      type: 'edit',
      buffer: { text: 'ab\ncd', cursor: 3 },
    })
    expect(applyPromptInput(createPromptBuffer('draft'), '', { ...noKey, upArrow: true })).toEqual({
      type: 'history',
      direction: 'older',
    })
    expect(
      applyPromptInput(createPromptBuffer('draft'), '', { ...noKey, downArrow: true }),
    ).toEqual({ type: 'history', direction: 'newer' })
  })
})

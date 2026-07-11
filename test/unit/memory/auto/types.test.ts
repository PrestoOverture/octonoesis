import { describe, expect, it } from 'bun:test'
import {
  MEMORY_TYPES,
  memoryFileSchema,
  memoryWriteSchema,
} from '../../../../src/memory/auto/types'

describe('auto-memory types', () => {
  it('accepts exactly the four memory types', () => {
    expect(MEMORY_TYPES).toEqual(['user', 'feedback', 'project', 'reference'])
    for (const type of MEMORY_TYPES) {
      expect(
        memoryWriteSchema.parse({
          action: 'create',
          name: 'memory-name',
          type,
          description: 'Description',
          content: 'Body',
        }).type,
      ).toBe(type)
    }
    expect(
      memoryFileSchema.safeParse({
        name: 'memory-name',
        description: 'Description',
        type: 'other',
        content: 'Body',
        path: '/tmp/memory-name.md',
        mtime: 1,
      }).success,
    ).toBe(false)
  })
})

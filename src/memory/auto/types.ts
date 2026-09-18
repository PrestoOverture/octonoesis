import { z } from 'zod'

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const

export const memoryTypeSchema = z.enum(MEMORY_TYPES)
export type MemoryType = z.infer<typeof memoryTypeSchema>

/** Stored auto-memory file containing markdown content and frontmatter metadata. */
export interface MemoryFile {
  name: string
  description: string
  type: MemoryType
  content: string
  path: string
  mtime: number
}

/** Proposed file creation, update, or deletion operation emitted during memory extraction. */
export interface MemoryWrite {
  action: 'create' | 'update' | 'delete'
  name: string
  type: MemoryType
  description: string
  content: string
}

export const memoryFileSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    type: memoryTypeSchema,
    content: z.string(),
    path: z.string(),
    mtime: z.number(),
  })
  .strict()

export const memoryWriteSchema = z
  .object({
    action: z.enum(['create', 'update', 'delete']),
    name: z.string(),
    type: memoryTypeSchema,
    description: z.string(),
    content: z.string(),
  })
  .strict()

export const memoryWritesSchema = z.array(memoryWriteSchema)

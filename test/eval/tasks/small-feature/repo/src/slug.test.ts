import { expect, test } from 'bun:test'
import { slugify } from './slug'

test('slugify implements the URL slug specification', () => {
  expect(slugify('  Hello, World!  ')).toBe('hello-world')
  expect(slugify('API_v2 / Docs')).toBe('api-v2-docs')
  expect(slugify('--Already---Slug--')).toBe('already-slug')
  expect(slugify('***')).toBe('')
  expect(slugify('')).toBe('')
})

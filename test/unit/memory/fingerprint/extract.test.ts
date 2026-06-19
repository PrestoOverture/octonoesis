import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  PROMPT_HASH,
  assembleFingerprint,
  extractFingerprint,
  getFallbackFingerprint,
} from '../../../../src/memory/fingerprint/extract.ts'
import { setProvider } from '../../../../src/providers/index.ts'
import type { LLMProvider, StreamEvent } from '../../../../src/providers/types.ts'

describe('LLM Fingerprint Extractor', () => {
  const originalProvider: LLMProvider | null = null

  beforeEach(() => {
    // In these unit tests, we'll configure setProvider to hook up mocks
  })

  afterEach(() => {
    setProvider(null) // Restore original
  })

  it('should have a deterministic, versioned prompt hash', () => {
    expect(PROMPT_HASH).toBeDefined()
    expect(PROMPT_HASH.length).toBe(8)
  })

  it('should successfully extract fingerprint from structured LLM JSON response', async () => {
    const mockJson = {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/buggy.ts',
      expression: "evaluating 'user.name'",
    }

    const mockProvider: LLMProvider = {
      name: 'anthropic',
      createMessageStream: async function* () {
        yield { type: 'text_delta', text: JSON.stringify(mockJson) }
      },
    }

    setProvider(mockProvider)

    const result = await extractFingerprint(
      'TypeError: null is not an object at src/buggy.ts:7:20',
      'bun test test/fixtures/buggy-repo',
      { model: 'mock-model' },
    )

    expect(result.coarse).toBe('bun-test|TypeError')
    expect(result.medium).toBe('bun-test|TypeError|src/buggy.ts')
    expect(result.fine).toBe("bun-test|TypeError|src/buggy.ts|evaluating 'user.name'")
  })

  it('should clean markdown formatting fences from the LLM response', async () => {
    const responseWithFences = `
Here is the extracted information:
\`\`\`json
{
  "tool": "tsc",
  "error_class": "TS2345",
  "file": "src/state.ts",
  "expression": "Type 'string' is not assignable to 'number'"
}
\`\`\`
`

    const mockProvider: LLMProvider = {
      name: 'anthropic',
      createMessageStream: async function* () {
        yield { type: 'text_delta', text: responseWithFences }
      },
    }

    setProvider(mockProvider)

    const result = await extractFingerprint(
      "error TS2345: Type 'string' is not assignable to 'number' in src/state.ts:10",
      'bun run typecheck',
      { model: 'mock-model' },
    )

    expect(result.coarse).toBe('tsc|TS2345')
    expect(result.medium).toBe('tsc|TS2345|src/state.ts')
    expect(result.fine).toBe("tsc|TS2345|src/state.ts|Type 'string' is not assignable to 'number'")
  })

  it('should fall back to deterministic extraction when LLM fails or times out', async () => {
    const mockProvider: LLMProvider = {
      name: 'anthropic',
      createMessageStream: async function* () {
        yield* []
        throw new Error('API Connection Timeout')
      },
    }

    setProvider(mockProvider)

    const result = await extractFingerprint(
      'TypeError: null is not an object at src/buggy.ts:7:20',
      'bun test test/fixtures/buggy-repo',
      { model: 'mock-model' },
    )

    // Fallback checks command for tool, and scans text for *Error patterns
    expect(result.coarse).toBe('bun|TypeError')
    expect(result.medium).toBe('bun|TypeError')
    expect(result.fine).toBe('bun|TypeError')
  })

  it('should fall back to deterministic extraction when LLM returns invalid JSON', async () => {
    const mockProvider: LLMProvider = {
      name: 'anthropic',
      createMessageStream: async function* () {
        yield { type: 'text_delta', text: 'This is not valid JSON string.' }
      },
    }

    setProvider(mockProvider)

    const result = await extractFingerprint(
      'SyntaxError: unexpected token at src/state.ts:15',
      'bun run typecheck',
      { model: 'mock-model' },
    )

    expect(result.coarse).toBe('bun|SyntaxError')
  })

  it('should normalize pipe separators in fields when assembling fingerprint', () => {
    const result = assembleFingerprint('bun|test', 'Type|Error', 'src|buggy.ts', 'eval|user.name')

    expect(result.coarse).toBe('bun-test|Type-Error')
    expect(result.medium).toBe('bun-test|Type-Error|src-buggy.ts')
    expect(result.fine).toBe('bun-test|Type-Error|src-buggy.ts|eval-user.name')
  })

  it('should handle getFallbackFingerprint helper with relative command path', () => {
    const result = getFallbackFingerprint(
      'ReferenceError: x is not defined',
      './bin/custom-test-runner --flag',
    )

    expect(result.coarse).toBe('custom-test-runner|ReferenceError')
    expect(result.medium).toBe('custom-test-runner|ReferenceError')
    expect(result.fine).toBe('custom-test-runner|ReferenceError')
  })
})

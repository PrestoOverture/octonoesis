import { afterEach, describe, expect, it } from 'bun:test'
import type { Episode } from '../../../../src/memory/episodes/types.ts'
import {
  DISTILL_PROMPT_TEMPLATE,
  PROMPT_HASH,
  distillEpisode,
} from '../../../../src/memory/rules/distill.ts'
import { setProvider } from '../../../../src/providers/index.ts'
import type { LLMProvider } from '../../../../src/providers/types.ts'

describe('Rule Distillation', () => {
  afterEach(() => {
    setProvider(null)
  })

  it('should have a deterministic 8-character prompt hash', () => {
    expect(PROMPT_HASH).toBeDefined()
    expect(PROMPT_HASH.length).toBe(8)
  })

  const mockEpisode: Episode = {
    id: 'ep_0001',
    timestamp: '2026-06-20T10:00:00Z',
    session_id: 'sess-123',
    task_digest: 'fix optional chaining error in src/buggy.ts',
    failure: {
      tool: 'Bash',
      cmd: 'bun test',
      error_class: 'TypeError',
      signature: 'bash|TypeError|src/buggy.ts',
    },
    fix_candidates: [
      {
        tool: 'Edit',
        path: 'src/buggy.ts',
        summary: 'add optional chaining',
        role: 'direct',
      },
    ],
    attribution: {
      status: 'single_direct',
      primary: 'src/buggy.ts',
      confidence: 0.9,
    },
    outcome: 'resolved',
    journal_line_range: { start: 1, end: 10 },
    value_score: 1.0,
    is_excluded: false,
    exclusion_reason: null,
  }

  it('should throw an error when attempting to distill an excluded episode', async () => {
    const excludedEpisode: Episode = {
      ...mockEpisode,
      is_excluded: true,
      exclusion_reason: 'abandoned',
    }

    expect(
      distillEpisode(excludedEpisode, { model: 'mock-model', extractorVersion: '0.2.0' }),
    ).rejects.toThrow('Cannot distill excluded episode: abandoned')
  })

  it('should successfully distill rule from mock LLM response', async () => {
    const mockJson = {
      slug: 'optional-chaining-buggy',
      triggers: {
        tools: ['Bash'],
        command_prefix: ['bun test'],
        error_signatures: ['bash|TypeError|src/buggy.ts'],
      },
      anchor_file: 'src/buggy.ts',
      advice: 'Always use optional chaining when accessing property of potentially null object.',
    }

    const mockProvider: LLMProvider = {
      name: 'anthropic',
      createMessageStream: async function* () {
        yield { type: 'text_delta', text: JSON.stringify(mockJson) }
      },
    }

    setProvider(mockProvider)

    const rule = await distillEpisode(mockEpisode, {
      model: 'mock-model',
      extractorVersion: '0.2.0',
    })

    expect(rule.id).toBe('rule-optional-chaining-buggy')
    expect(rule.triggers.tools).toEqual(['Bash'])
    expect(rule.triggers.command_prefix).toEqual(['bun test'])
    expect(rule.triggers.error_signatures).toEqual([
      'bash|TypeError|src/buggy.ts',
      'bash|TypeError',
    ])
    expect(rule.anchor.file).toBe('src/buggy.ts')
    expect(rule.advice).toBe(
      'Always use optional chaining when accessing property of potentially null object.',
    )
    expect(rule.confidence).toBe(0.6)
    expect(rule.evidence).toEqual(['ep_0001'])
    expect(rule.status).toBe('candidate')
    expect(rule.extractor_version).toBe('0.2.0')
    expect(rule.model_id).toBe('mock-model')
    expect(rule.prompt_hash).toBe(PROMPT_HASH)
  })

  it('should render evidence into the prompt when present', async () => {
    const mockJson = {
      slug: 'optional-chaining-buggy',
      triggers: {
        tools: ['Bash'],
        command_prefix: ['bun test'],
        error_signatures: ['bash|TypeError|src/buggy.ts'],
      },
      anchor_file: 'src/buggy.ts',
      advice: 'Always use optional chaining when accessing property of potentially null object.',
    }

    let capturedPrompt = ''
    const mockProvider: LLMProvider = {
      name: 'anthropic',
      createMessageStream: async function* (messages) {
        const first = messages[0]
        const content = first?.content
        if (typeof content === 'string') {
          capturedPrompt = content
        } else if (Array.isArray(content)) {
          const textPart = content.find(
            (part): part is { type: 'text'; text: string } => part.type === 'text',
          )
          capturedPrompt = textPart?.text ?? ''
        }
        yield { type: 'text_delta', text: JSON.stringify(mockJson) }
      },
    }

    setProvider(mockProvider)

    await distillEpisode(mockEpisode, {
      model: 'mock-model',
      extractorVersion: '0.2.0',
      evidence: {
        errorExcerpt: 'TypeError: Cannot read properties of null (reading \'foo\')',
        fixDiff: 'obj.foo -> obj?.foo',
      },
    })

    expect(capturedPrompt).toContain(
      "TypeError: Cannot read properties of null (reading 'foo')",
    )
    expect(capturedPrompt).toContain('obj.foo -> obj?.foo')
  })

  it('should render (not captured) fallback when evidence is absent', async () => {
    const mockJson = {
      slug: 'optional-chaining-buggy',
      triggers: {
        tools: ['Bash'],
        command_prefix: ['bun test'],
        error_signatures: ['bash|TypeError|src/buggy.ts'],
      },
      anchor_file: 'src/buggy.ts',
      advice: 'Always use optional chaining when accessing property of potentially null object.',
    }

    let capturedPrompt = ''
    const mockProvider: LLMProvider = {
      name: 'anthropic',
      createMessageStream: async function* (messages) {
        const first = messages[0]
        const content = first?.content
        if (typeof content === 'string') {
          capturedPrompt = content
        } else if (Array.isArray(content)) {
          const textPart = content.find(
            (part): part is { type: 'text'; text: string } => part.type === 'text',
          )
          capturedPrompt = textPart?.text ?? ''
        }
        yield { type: 'text_delta', text: JSON.stringify(mockJson) }
      },
    }

    setProvider(mockProvider)

    await expect(
      distillEpisode(mockEpisode, {
        model: 'mock-model',
        extractorVersion: '0.2.0',
      }),
    ).resolves.toBeDefined()

    const notCapturedCount = capturedPrompt.split('(not captured)').length - 1
    expect(notCapturedCount).toBe(2)
  })

  it('should include the generalization requirement in the prompt template', () => {
    expect(DISTILL_PROMPT_TEMPLATE).toContain(
      'Your advice must help with a FUTURE occurrence of this error class, not just restate this one instance.',
    )
  })

  it('should distinguish stable repo facts from one-off instance detail in the prompt template', () => {
    expect(DISTILL_PROMPT_TEMPLATE).toContain('Stable repo-structural fact revealed by the evidence')
    expect(DISTILL_PROMPT_TEMPLATE).toContain('One-off instance detail with no stable fact behind it')
  })
})

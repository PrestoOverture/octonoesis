import { afterEach, describe, expect, it } from 'bun:test'
import type { Episode } from '../../../../src/memory/episodes/types.ts'
import { PROMPT_HASH, distillEpisode } from '../../../../src/memory/rules/distill.ts'
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
})

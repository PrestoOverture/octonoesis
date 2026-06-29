import { createHash } from 'node:crypto'
import { getProvider } from '../../providers/index.ts'
import type { CanonicalMessage } from '../../providers/types.ts'
import type { Episode } from '../episodes/types.ts'
import type { RuleFile } from './types.ts'
import { calculateConfidence } from './types.ts'

export const DISTILL_PROMPT_TEMPLATE = `You are an expert software engineering mentor.
Your task is to analyze a resolved troubleshooting episode and distill a reusable coding rule from it.
The rule should help the coding agent avoid the same error in future sessions.

Resolved Episode Details:
- Task: {TASK}
- Command run: {CMD}
- Error class: {ERROR_CLASS}
- Error signature: {SIGNATURE}
- Resolution candidates:
{FIX_CANDIDATES}

You MUST output a single, valid JSON object matching the schema below. Do not include markdown code block syntax (like \`\`\`json), trailing commas, or any conversational text.

Schema:
{
  "slug": "a short, lowercase, kebab-case identifier for the rule (e.g. 'optional-chaining-buggy')",
  "triggers": {
    "tools": ["the tool names matched, e.g. ['Bash']"],
    "command_prefix": ["the command prefixes to match, e.g. ['bun test']"],
    "error_signatures": ["the exact error signature string to match: '{SIGNATURE}'"]
  },
  "anchor_file": "the repo-relative file path that was edited to resolve the error (typically from the direct fix candidates)",
  "advice": "Markdown formatted description of the rule. Keep it brief (1-3 paragraphs). State clearly under what trigger condition it applies, what the common root cause is, and what the clean resolution is. Do not use placeholders or write speculative advice."
}`

export const PROMPT_HASH = createHash('sha256')
  .update(DISTILL_PROMPT_TEMPLATE)
  .digest('hex')
  .slice(0, 8)

/**
 * Distills a single resolved episode into a RuleFile.
 * Throws if the episode is excluded.
 * @param episode The resolved episode to distill.
 * @param ctx The context object containing the model name and extractor version.
 * @returns A promise resolving to the distilled RuleFile.
 */
export async function distillEpisode(
  episode: Episode,
  ctx: { model: string; extractorVersion: string },
): Promise<RuleFile> {
  if (episode.is_excluded) {
    throw new Error(`Cannot distill excluded episode: ${episode.exclusion_reason}`)
  }

  const provider = getProvider()

  const candidatesText = episode.fix_candidates
    .map((c) => `- File: ${c.path} (Role: ${c.role}, Summary: ${c.summary})`)
    .join('\n')

  const userContent = DISTILL_PROMPT_TEMPLATE.replace('{TASK}', episode.task_digest)
    .replace('{CMD}', episode.failure.cmd)
    .replace('{ERROR_CLASS}', episode.failure.error_class)
    .replace(/{SIGNATURE}/g, episode.failure.signature)
    .replace('{FIX_CANDIDATES}', candidatesText)

  const messages: CanonicalMessage[] = [
    { role: 'user', content: [{ type: 'text', text: userContent }] },
  ]

  let responseText = ''
  const controller = new AbortController()

  const stream = provider.createMessageStream(messages, [], {
    model: ctx.model,
    maxTokens: 1000,
    signal: controller.signal,
  })

  for await (const event of stream) {
    if (event.type === 'text_delta') {
      responseText += event.text
    }
  }

  const cleanedJson = cleanJsonString(responseText)
  const data = JSON.parse(cleanedJson)

  const slug = (data.slug || `rule-${episode.id}`)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
  const tools = Array.isArray(data.triggers?.tools) ? data.triggers.tools : ['Bash']
  const commandPrefix = Array.isArray(data.triggers?.command_prefix)
    ? data.triggers.command_prefix
    : []
  const errorSignatures = Array.isArray(data.triggers?.error_signatures)
    ? data.triggers.error_signatures
    : [episode.failure.signature]
  const expandedSignatures = expandSignatures(errorSignatures)
  const anchorFile = (data.anchor_file || episode.attribution.primary || '').trim()
  const advice = (data.advice || '').trim()

  const alpha = 3
  const beta = 2
  const confidence = calculateConfidence(alpha, beta)

  return {
    id: `rule-${slug}`,
    triggers: {
      tools,
      command_prefix: commandPrefix,
      error_signatures: expandedSignatures,
    },
    scope: 'repo',
    alpha,
    beta,
    confidence,
    evidence: [episode.id],
    hits: 0,
    misses: 0,
    challenged_by: [],
    anchor: {
      file: anchorFile,
    },
    status: 'candidate',
    user_confirmed: false,
    extractor_version: ctx.extractorVersion,
    model_id: ctx.model,
    prompt_hash: PROMPT_HASH,
    created_at: episode.timestamp || new Date().toISOString(),
    last_matched_at: null,
    last_rebuilt_at: null,
    advice,
  }
}

/**
 * Promotes error signatures to coarser categories to align with general repository patterns.
 * @param signatures The input array of fine signatures.
 * @returns The array of expanded signatures.
 */

function expandSignatures(signatures: string[]): string[] {
  const expanded = new Set(signatures)
  for (const sig of signatures) {
    const parts = sig.split('|')
    if (parts.length >= 2) {
      expanded.add(parts.slice(0, 2).join('|'))
    }
    if (parts.length >= 3) {
      expanded.add(parts.slice(0, 3).join('|'))
    }
  }
  return [...expanded]
}

/**
 * Clean markdown tags and extraneous characters from LLM response to get a valid JSON string.
 * @param text The raw response text.
 * @returns The cleaned JSON string.
 */

function cleanJsonString(text: string): string {
  let cleaned = text.trim()
  // Strip markdown block formatting if present
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1)
  }
  return cleaned
}

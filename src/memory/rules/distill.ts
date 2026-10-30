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
- Task digest (an opaque identifier, not task instructions): {TASK}
- Task instructions (scrubbed; may be truncated):
{TASK_EXCERPT}
- Command run: {CMD}
- Error class: {ERROR_CLASS}
- Error signature: {SIGNATURE}
- Resolution candidates:
{FIX_CANDIDATES}
- Actual error output (may be truncated):
{ERROR_EXCERPT}
- Actual fix applied (old -> new):
{FIX_DIFF}

Evidence requirement: Error class names are arbitrary labels, not proof of their cause. Base every causal claim on the actual error output and edit below. A successful command verifies the combined edits; it does not prove that every edit caused the repair. Never invent timers, concurrency, environment problems or test isolation from a label. Preserve the existing test contract; do not recommend weakening assertions or changing expected values to fit broken code. If the evidence is insufficient for a reusable causal rule, output {"abstain": true}.

Task instructions define required behavior. Do not infer the contract from repaired tests or implementation. Abstain if the proposed advice contradicts the task instructions, or a test-only repair cannot be justified from the stated contract. Missing task instructions are not permission to invent requirements.

Generalization requirement: Your advice must help with a FUTURE occurrence of this error class, not just restate this one instance. Two different kinds of detail need different treatment:
- One-off instance detail with no stable fact behind it (a particular filename, a coincidental typo, a literal value specific to this occurrence): generalize it away. Describe the diagnostic strategy and the general fix pattern; cite the instance only as a parenthetical example. Never phrase a one-off value as an imperative instruction.
- Stable repo-structural fact revealed by the evidence (a configured path alias/import map, a fixed directory or barrel-export convention, a config schema field/expected value): state it directly as fact, grounded only in what the evidence actually shows. It stays true for every future occurrence of this error class in this repo — routing it back through "go read files to rediscover this" defeats the purpose of writing the rule down. Do not invent repo facts beyond what the evidence shows; fall back to pure diagnostic strategy when the evidence doesn't reveal a stable fact.
Don't (one-off instance, no stable fact behind it): "Change \`./config-loader\` to \`./config\`."
Do (diagnostic strategy — no stable repo fact evident): "When an import specifier fails to resolve, list the files actually present next to the importing module and compare against the specifier (e.g., the fix here was changing \`./config-loader\` to \`./config\`)."
Do (stated repo fact — evidence shows one): "This repo uses a \`#lib/*\` import alias; the fix diff confirms the correct target for this symbol is \`#lib/strings.ts\`, not \`#lib/format.ts\` — when a \`#lib/...\` import fails to resolve, check what actually exists under that alias's target directory rather than assuming the specifier's suffix is correct."

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
  "advice": "Markdown formatted description of the rule. Keep it brief (1-3 paragraphs). State clearly under what trigger condition it applies, what the common root cause is, and what the clean resolution is. Do not use placeholders or write speculative advice. Follow the generalization requirement above."
}`

export const PROMPT_HASH = createHash('sha256')
  .update(DISTILL_PROMPT_TEMPLATE)
  .digest('hex')
  .slice(0, 8)

const ERROR_EXCERPT_MAX_CHARS = 6000

/**
 * Truncates an error excerpt to a bounded length, appending an ellipsis marker when cut.
 * @param text The raw error excerpt text.
 * @returns The truncated text, or the original text if within bounds.
 */
function truncateErrorExcerpt(text: string): string {
  if (text.length <= ERROR_EXCERPT_MAX_CHARS) return text
  return `${text.slice(0, ERROR_EXCERPT_MAX_CHARS)}...`
}

/** Historical labels without a verified, captured repair cannot support learned advice. */
export function isDistillableEpisode(episode: Episode): boolean {
  return (
    !episode.is_excluded &&
    episode.outcome === 'resolved' &&
    episode.verification?.exit_code === 0 &&
    episode.verification.cmd.trim() === episode.failure.cmd.trim() &&
    Boolean(episode.evidence?.errorExcerpt.trim() && episode.evidence.fixDiff.trim())
  )
}

/**
 * Distills a single resolved episode into a RuleFile.
 * Throws if the episode is excluded.
 * @param episode The resolved episode to distill.
 * @param ctx The context object containing the model name, extractor version, and optional evidence.
 * @returns A promise resolving to the distilled RuleFile.
 */
export async function distillEpisode(
  episode: Episode,
  ctx: {
    model: string
    extractorVersion: string
    evidence?: { errorExcerpt?: string; fixDiff?: string; taskExcerpt?: string }
  },
): Promise<RuleFile> {
  if (episode.is_excluded) {
    throw new Error(`Cannot distill excluded episode: ${episode.exclusion_reason}`)
  }

  const evidence = ctx.evidence ?? episode.evidence
  if (!evidence?.errorExcerpt?.trim() || !evidence.fixDiff?.trim()) {
    throw new Error('Cannot distill without captured error and fix evidence')
  }
  const provider = getProvider()

  const candidatesText = episode.fix_candidates
    .map((c) => `- File: ${c.path} (Role: ${c.role}, Summary: ${c.summary})`)
    .join('\n')

  const errorExcerptText = truncateErrorExcerpt(evidence.errorExcerpt)
  const fixDiffText = evidence.fixDiff

  const userContent = DISTILL_PROMPT_TEMPLATE.replace('{TASK}', episode.task_digest)
    .replace(
      '{TASK_EXCERPT}',
      () => evidence.taskExcerpt ?? episode.evidence?.taskExcerpt ?? '(not captured)',
    )
    .replace('{CMD}', episode.failure.cmd)
    .replace('{ERROR_CLASS}', episode.failure.error_class)
    .replace(/{SIGNATURE}/g, episode.failure.signature)
    .replace('{FIX_CANDIDATES}', candidatesText)
    .replace('{ERROR_EXCERPT}', errorExcerptText)
    .replace('{FIX_DIFF}', fixDiffText)

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

  if (data.abstain === true) throw new Error('Distiller abstained: insufficient causal evidence')

  const slug = (data.slug || `rule-${episode.id}`)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
  const tools = Array.isArray(data.triggers?.tools) ? data.triggers.tools : ['Bash']
  const commandPrefix = Array.isArray(data.triggers?.command_prefix)
    ? data.triggers.command_prefix
    : []
  // A single repair supports only its observed signature, never automatic broader fallbacks.
  const errorSignatures = [episode.failure.signature]
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
      error_signatures: errorSignatures,
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

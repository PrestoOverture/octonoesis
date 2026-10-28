import fs from 'node:fs/promises'
import path from 'node:path'
import { loadRule, saveRule } from '../../src/memory/rules/store'
import type { RuleFile } from '../../src/memory/rules/types'
import { registerPromptHandler, unregisterPromptHandler } from '../../src/permissions/confirm'
import { setProvider } from '../../src/providers'
import type { CanonicalMessage } from '../../src/providers/types'
import { type StreamEvent, query } from '../../src/query/engine'
import type { QueryLoopContext } from '../../src/query/types'
import { bashTool } from '../../src/tools/Bash'
import { editTool } from '../../src/tools/Edit'
import { readTool } from '../../src/tools/Read'
import { registerTool } from '../../src/tools/registry'

export function seededRule(id = 'rule-fix'): RuleFile {
  return {
    id,
    triggers: { tools: ['Bash'], command_prefix: [], error_signatures: ['bash|TypeError'] },
    scope: 'repo',
    alpha: 3,
    beta: 2,
    confidence: 0.6,
    evidence: ['ep_seed'],
    hits: 0,
    misses: 0,
    challenged_by: [],
    anchor: { file: 'bug.txt' },
    status: 'active',
    user_confirmed: false,
    extractor_version: 'test',
    model_id: 'test',
    prompt_hash: 'test',
    created_at: new Date().toISOString(),
    last_matched_at: null,
    last_rebuilt_at: null,
    advice: 'Replace broken with fixed.',
  }
}

export function promptText(messages: CanonicalMessage[]) {
  const content = messages[0]?.content
  return typeof content === 'string' ? content : JSON.stringify(content)
}

/** A real Bash → Read → Edit → same Bash script, shared by the main parity fixture. */
export async function learningScript(root: string, fault = false) {
  await fs.writeFile(path.join(root, 'bug.txt'), 'broken\n')
  await saveRule(seededRule())
  for (const tool of [bashTool, readTool, editTool]) registerTool(tool)
  registerPromptHandler(async () => 'allow_always')
  const command =
    'if [ "$(cat bug.txt)" = fixed ]; then echo passed; else echo \'TypeError: broken at bug.txt\'; exit 1; fi'
  const steps = [
    { id: 'fail', name: 'Bash', input: { command } },
    { id: 'read', name: 'Read', input: { path: 'bug.txt' } },
    {
      id: 'edit',
      name: 'Edit',
      input: { path: 'bug.txt', old_string: 'broken', new_string: 'fixed' },
    },
    { id: 'pass', name: 'Bash', input: { command } },
  ]
  const inputs: unknown[] = []
  let turn = 0
  setProvider({
    name: 'anthropic',
    async *createMessageStream(messages, _tools, options) {
      if (promptText(messages).includes('precise tool execution error analyzer')) {
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            tool: 'bash',
            error_class: 'TypeError',
            file: 'bug.txt',
            expression: 'broken',
          }),
        }
      } else {
        inputs.push(JSON.parse(JSON.stringify({ messages, system: options.system })))
        const step = steps[turn++]
        if (fault && step?.id === 'pass')
          await fs.mkdir(path.join(process.env.OCTONOESIS_MEMORY_DIR ?? '', 'rules.lock'))
        if (step) yield { type: 'tool_use', ...step }
        else yield { type: 'text_delta', text: 'Fixed.' }
      }
      yield {
        type: 'message_end',
        stopReason: 'other',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    },
  })
  const ctx: QueryLoopContext = { repoRoot: root, sessionId: 'learning-script', messages: [] }
  const events: StreamEvent[] = []
  try {
    const generator = query('Fix bug.txt', ctx)
    let step = await generator.next()
    while (!step.done) {
      events.push(step.value)
      step = await generator.next()
    }
    const rule = await loadRule('rule-fix')
    const journal = (
      await fs.readFile(path.join(process.env.OCTONOESIS_MEMORY_DIR ?? '', 'journal.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.kind === 'tool')
      .map(({ ts: _timestamp, duration_ms: _duration, ...event }) => event)
    return {
      events,
      result: step.value,
      ledger: { hits: rule?.hits, alpha: rule?.alpha, confidence: rule?.confidence, journal },
      messages: ctx.messages,
      inputs,
    }
  } finally {
    setProvider(null)
    unregisterPromptHandler()
  }
}

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseConfig } from '../../src/config/schema'
import { getProvider, setProvider } from '../../src/providers'
import { getActiveForkPids } from '../../src/providers/fork'
import type { CanonicalMessage, LLMProvider } from '../../src/providers/types'
import { query } from '../../src/query'
import { type CompactResult, compact, createCompactSummaryMessage } from '../../src/query/compact'
import { bashTool } from '../../src/tools/Bash'
import { editTool } from '../../src/tools/Edit'
import { readTool } from '../../src/tools/Read'
import { clearRegistry, registerTool } from '../../src/tools/registry'
import { shellChildEnv } from '../../src/utils/childEnv'
import { getSparkKey } from '../../src/utils/env'
import { contextTokensWithEstimation } from '../../src/utils/tokens'
import { assertPairedHistory, evaluateCompactionQuality } from '../helpers/compactionQuality'

if (process.argv.includes('--fork-child')) {
  const { forkChildMain } = await import('../../src/providers/forkChild')
  process.exit(await forkChildMain())
}
const stage = process.argv[2] ?? '4'
assert.ok(['4', '5'].includes(stage))
assert.ok(getSparkKey())
process.env.LLM_PROVIDER = 'spark'
process.env.OCTONOESIS_DISABLE_MEMORY = '1'
if (stage === '4') process.env.OCTONOESIS_DISABLE_COMPACT = '1'
else {
  Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_COMPACT')
  process.env.OCTONOESIS_COMPACT_THRESHOLD = '8000'
}
Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_MOCK')
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'octo-quality-spark-')))
process.env.OCTONOESIS_MEMORY_DIR = path.join(root, '.memory')
const originalCwd = process.cwd()
process.chdir(root)
try {
  const marker = `RELEASE_${crypto.randomUUID()}`
  const lateFact = `LATE_${crypto.randomUUID()}`
  const guard = `unchanged_${crypto.randomUUID()}`
  await fs.writeFile(path.join(root, 'guard.txt'), guard)
  await fs.writeFile(
    path.join(root, 'calc.ts'),
    `// evidence code: ${lateFact}\n${stage === '5' ? `// ${'background pressure fixture '.repeat(1800)}\n` : ''}export function calculate(x: number): number { return x * 2 }\n`,
  )
  const tests =
    'import {expect,test} from "bun:test"; import {calculate} from "./calc"; test("contract",()=>{expect(calculate(2)).toBe(14);expect(calculate(-3)).toBe(-21);expect(calculate(0)).toBe(0)})\n'
  await fs.writeFile(path.join(root, 'calc.test.ts'), tests)
  const failed = spawnSync('bun', ['test'], { cwd: root, env: shellChildEnv(), encoding: 'utf8' })
  assert.equal(failed.status, 1, 'Fixture must start with a real failing test')
  const constraint =
    'Only edit calc.ts; never edit calc.test.ts or guard.txt. Preserve export function calculate(x: number): number. Run bun test after the fix.'
  let messages: CanonicalMessage[] = [
    {
      role: 'user',
      content:
        'Finish the pending calculation bug. Follow earlier constraints and include the release marker from the earlier specification in your final answer.',
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Inspected repository context. '.repeat(stage === '5' ? 850 : 1500) },
      ],
    },
    { role: 'user', content: constraint },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'spec-read', name: 'Read', input: { path: 'specification.txt' } },
      ],
    },
    {
      role: 'tool',
      tool_use_id: 'spec-read',
      content: `Specification: calculate must multiply by 7. Release marker: ${marker}. This marker must be included verbatim in the final answer.`,
    },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'initial-test', name: 'Bash', input: { command: 'bun test' } },
      ],
    },
    {
      role: 'tool',
      tool_use_id: 'initial-test',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'initial-test',
          is_error: true,
          content: `bun test failed (exit 1); implementation is NOT fixed.\n${failed.stderr}`,
        },
        {
          type: 'text',
          text: `bun test failed (exit 1); implementation is NOT fixed.\n${failed.stderr}`,
        },
      ],
    },
    { role: 'user', content: 'Continue with the pending fix.' },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Next action: read the current implementation, apply the specification, then verify.',
        },
      ],
    },
    { role: 'user', content: 'Please implement the pending fix using tools and verify it.' },
  ]
  const contract = {
    summaryLiterals: [marker, '7', 'initial-test'],
    historyLiterals: ['calc.ts', 'guard.txt', 'Only edit calc.ts'],
    forbiddenSummaryLiterals: ['all tests passed'],
    continuationLiterals: stage === '5' ? [marker, lateFact] : [marker],
  }
  const tokenMetrics = []
  let lastResult: CompactResult | undefined
  for (let round = 0; stage === '4' && round < 2; round++) {
    if (round)
      messages.splice(2, 0, {
        role: 'assistant',
        content: [{ type: 'text', text: 'Additional irrelevant inspection notes. '.repeat(1200) }],
      })
    lastResult = await compact(messages, {
      systemPrompt:
        'You summarize observed coding work accurately. Preserve unresolved failures and exact identifiers.',
      preserveTaskState: true,
      signal: AbortSignal.timeout(60000),
    })
    evaluateCompactionQuality(lastResult, contract)
    messages = [
      lastResult.pinnedHead,
      createCompactSummaryMessage(lastResult.summary),
      ...lastResult.messagesKept,
    ]
    tokenMetrics.push({ before: lastResult.preCompactTokens, after: lastResult.postCompactTokens })
  }
  clearRegistry()
  for (const tool of [readTool, editTool, bashTool]) registerTool(tool)
  let overlapped = false
  let crossedHardThreshold = false
  const provider = getProvider()
  const calls: CanonicalMessage[][] = []
  if (stage === '5') {
    const recording: LLMProvider = {
      name: provider.name,
      async *createMessageStream(messages, tools, opts) {
        if (!calls.length) {
          overlapped = getActiveForkPids().length > 0
          assert.ok(
            contextTokensWithEstimation(messages) < 8000,
            'Initial request must start below the hard threshold',
          )
        }
        calls.push(structuredClone(messages))
        yield* provider.createMessageStream(messages, tools, opts)
      },
    }
    setProvider(recording)
  }
  const ctx = {
    repoRoot: root,
    messages,
    config: parseConfig({
      maxTurns: 10,
      projectInstructions: 'off',
      compaction: { toolResultClearing: { enabled: false } },
      permissions: {
        allowPatterns: ['Edit', 'Bash(bun test*)', `Bash(cd ${root} && bun test*)`],
        denyPatterns: [],
      },
    }),
  }
  const run = query(
    `Execute the pending coding task now. First call Read with path ${path.join(root, 'calc.ts')}. Then use Edit to fix it according to the earlier specification. Run bun test using Bash in repository ${root}. Report the exact release marker from the earlier specification and the evidence code from calc.ts. This is an instruction to perform the work, not a status request.`,
    ctx,
    AbortSignal.timeout(180000),
  )
  const tools: string[] = []
  const applied: { preTokens: number; postTokens: number }[] = []
  let step = await run.next()
  while (!step.done) {
    if (step.value.type === 'compact') {
      applied.push(step.value)
      crossedHardThreshold ||= step.value.preTokens > 8000
    }
    if (step.value.type === 'tool_done') {
      console.log(JSON.stringify({ tool: step.value.name, status: step.value.status }))
      if (step.value.status === 'done') tools.push(step.value.name)
    }
    step = await run.next()
  }
  assert.equal(step.value.exit_reason, 'completed', step.value.error)
  if (stage === '5') {
    assert.ok(crossedHardThreshold, 'Fixture must exercise the hard-threshold wait path')
    assert.ok(overlapped, 'Main SPARK request must begin while the real summary child is running')
    assert.ok(applied.length > 0, 'Background summary must actually be installed')
    assert.ok(
      calls.some(
        (messages) =>
          JSON.stringify(messages).includes('<octo-compact-summary>') &&
          JSON.stringify(messages).includes(lateFact),
      ),
      'Post-snapshot read result must survive in a real subsequent SPARK request',
    )
    const summaryMessage = ctx.messages.find(
      (message) =>
        message.role === 'user' &&
        JSON.stringify(message.content).includes('<octo-compact-summary>'),
    )
    assert.ok(summaryMessage)
    const wrapped =
      typeof summaryMessage.content === 'string'
        ? summaryMessage.content
        : summaryMessage.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
    const metric = applied.at(-1)
    assert.ok(metric)
    lastResult = {
      summary: wrapped
        .replace('<octo-compact-summary>\n', '')
        .replace('\n</octo-compact-summary>', ''),
      pinnedHead: ctx.messages[0] as CanonicalMessage,
      messagesKept: ctx.messages.slice(2),
      preCompactTokens: metric.preTokens,
      postCompactTokens: metric.postTokens,
    }
    assert.equal(
      getActiveForkPids().length,
      0,
      'No summary process may leak after query completion',
    )
  }
  assert.ok(lastResult)
  assert.ok(
    step.value.final_message?.includes(marker),
    `Continuation omitted release marker: ${JSON.stringify(step.value)}; tools=${JSON.stringify(tools)}; latest=${JSON.stringify(ctx.messages.slice(-3))}`,
  )
  evaluateCompactionQuality(lastResult, contract, step.value.final_message)
  assertPairedHistory(ctx.messages)
  for (const tool of ['Read', 'Edit', 'Bash'])
    assert.ok(tools.includes(tool), `Continuation must actually execute ${tool}`)
  assert.equal(await fs.readFile(path.join(root, 'guard.txt'), 'utf8'), guard)
  assert.equal(await fs.readFile(path.join(root, 'calc.test.ts'), 'utf8'), tests)
  const verified = spawnSync('bun', ['test'], { cwd: root, env: shellChildEnv(), encoding: 'utf8' })
  assert.equal(verified.status, 0, verified.stderr)
  console.log(
    JSON.stringify({
      stage,
      overlapped,
      crossedHardThreshold,
      appliedCompactions: applied.length,
      status: 'PASS',
      compactions: tokenMetrics,
      tools,
      verifiedExit: verified.status,
      usage: step.value.usage,
    }),
  )
} finally {
  setProvider(null)
  process.chdir(originalCwd)
  await fs.rm(root, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseConfig } from '../../src/config/schema'
import type { CanonicalMessage } from '../../src/providers/types'
import { query } from '../../src/query'
import { readTool } from '../../src/tools/Read'
import { clearRegistry, registerTool } from '../../src/tools/registry'
import { getSparkKey } from '../../src/utils/env'

if (process.argv.includes('--fork-child')) {
  const { forkChildMain } = await import('../../src/providers/forkChild')
  process.exit(await forkChildMain())
}

// Opt-in real API test: bun test/demo/context-upgrade-spark.ts 1
const stage = process.argv[2] ?? '1'
assert.ok(['1', '2'].includes(stage), 'Unknown stage')
assert.ok(getSparkKey())
process.env.LLM_PROVIDER = 'spark'
process.env.OCTONOESIS_DISABLE_MEMORY = '1'
process.env.OCTONOESIS_COMPACT_THRESHOLD = stage === '1' ? '80000' : '4000'
Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_COMPACT')
Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_MOCK')
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'octo-context-spark-')))
process.env.OCTONOESIS_MEMORY_DIR = path.join(root, '.memory')
const originalCwd = process.cwd()
process.chdir(root)
try {
  const secret = `LIVE_${crypto.randomUUID()}`
  await fs.writeFile(path.join(root, 'fixture.txt'), `acceptance_code=${secret}\n`)
  const messages: CanonicalMessage[] = [
    {
      role: 'user',
      content: 'Inspect fixture.txt. The final answer must contain its current acceptance_code.',
    },
  ]
  for (let i = 0; i < 8; i++) {
    messages.push(
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: `old-${i}`, name: 'Read', input: { path: 'fixture.txt' } },
        ],
      },
      {
        role: 'tool',
        tool_use_id: `old-${i}`,
        content:
          i === 0
            ? 'obsolete file contents\n'.repeat(9000)
            : 'Previous version; re-read before answering.',
      },
    )
  }
  const contract = `CONTRACT_${crypto.randomUUID()}`
  if (stage === '2') {
    messages.splice(
      3,
      0,
      {
        role: 'user',
        content: `Hard constraint: include ${contract} verbatim in your final answer; do not edit any file.`,
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Constraint acknowledged.' }] },
      { role: 'user', content: 'Continue inspecting the fixture.' },
    )
    for (const message of messages) {
      if (
        message.role === 'tool' &&
        typeof message.content === 'string' &&
        message.content.includes('obsolete file contents')
      )
        message.content = 'Inspected old contents. '.repeat(1500)
    }
  }
  clearRegistry()
  registerTool(readTool)
  const ctx = {
    repoRoot: root,
    messages,
    config: parseConfig({
      maxTurns: 5,
      projectInstructions: 'off',
      compaction: { toolResultClearing: { enabled: stage === '1' } },
    }),
  }
  const run = query(
    `Read the absolute file ${path.join(root, 'fixture.txt')} using the Read tool now, then return its current acceptance_code and comply with earlier user constraints. Use that exact absolute path within the fixture repository. Do not guess.`,
    ctx,
    AbortSignal.timeout(120000),
  )
  let reads = 0
  let compacts = 0
  let step = await run.next()
  while (!step.done) {
    if (step.value.type === 'compact') compacts++
    if (step.value.type === 'tool_done' && step.value.name === 'Read') reads++
    step = await run.next()
  }
  assert.equal(step.value.exit_reason, 'completed', step.value.error)
  assert.ok(
    reads > 0,
    `Model must actually re-read the cleared evidence: ${step.value.final_message}`,
  )
  assert.ok(
    step.value.final_message?.includes(secret),
    `Model must recover the current fact from disk: ${JSON.stringify(step.value)}; history=${JSON.stringify(ctx.messages.slice(-3))}`,
  )
  if (stage === '1')
    assert.ok(
      JSON.stringify(ctx.messages).includes('<octo-cleared-tool-result>'),
      'Engine must clear old output',
    )
  assert.ok(
    !JSON.stringify(ctx.messages).includes('obsolete file contents'),
    'Large old result must be removed',
  )
  if (stage === '2') {
    assert.ok(compacts > 0, 'Real compaction must run')
    assert.ok(JSON.stringify(ctx.messages).includes('<octo-task-state>'))
    assert.ok(
      step.value.final_message?.includes(contract),
      'Earlier constraint must survive compaction',
    )
  }
  console.log(JSON.stringify({ stage, status: 'PASS', reads, compacts, usage: step.value.usage }))
} finally {
  process.chdir(originalCwd)
  await fs.rm(root, { recursive: true, force: true })
}

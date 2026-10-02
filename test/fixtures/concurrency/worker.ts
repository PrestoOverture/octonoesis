// biome-ignore lint/suspicious/noExplicitAny: Project uses local Bun runtime declarations.
declare const Bun: any
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { runSessionEndEpisodes } from '../../../src/memory/episodes/hook'
import { flushJournal } from '../../../src/memory/journal'
import { loadRule } from '../../../src/memory/rules/store'
import { executeTools, initQueryState } from '../../../src/query/engine'
import type { QueryLoopContext } from '../../../src/query/types'
import { withFileLock } from '../../../src/utils/fileLock'
import { restoreEnv } from '../../helpers/env'

const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
const [mode, target, ready, go] = process.argv.slice(2) as [string, string, string, string]
// Load before the barrier so every process begins with the same stale snapshot.
const snapshot = mode === 'hits' ? await loadRule('rule-shared', target) : undefined
await writeFile(ready, 'ready')
while (!(await Bun.file(go).exists())) await Bun.sleep(2)
for (let i = 0; i < 20; i++) {
  if (mode === 'episodes') {
    await runSessionEndEpisodes(path.basename(ready), target, target)
  } else if (mode === 'hits') {
    if (!snapshot) throw new Error('Missing rule')
    process.env.OCTONOESIS_MEMORY_DIR = path.dirname(target)
    const ctx: QueryLoopContext = {
      repoRoot: target,
      injectedRules: [
        {
          rule: snapshot,
          fingerprint: {
            tool: 'Bash',
            error_class: 'Error',
            file: '',
            expression: '',
            coarse: 'sig',
            medium: 'sig',
            fine: 'sig',
          },
        },
      ],
      recordedRuleOutcomes: new Set(),
      _lastVerifyResultForQuery: {
        isVerificationRun: true,
        verdict: 'PASS',
        fingerprints: [],
        command: 'test',
        exit_code: 0,
        stale: false,
      },
    }
    const state = Object.assign(await initQueryState('record hit', ctx), {
      provider: { name: 'anthropic' as const, async *createMessageStream() {} },
      system: '',
      dynamicSystem: '',
      tools: [],
    })
    for await (const _event of executeTools(state, ctx, [
      {
        type: 'tool_use',
        id: `read-${i}`,
        name: 'Read',
        input: { path: 'rule-shared.md' },
      },
    ])) {
      /* Drain the production accounting path. */
    }
    if (!ctx.recordedRuleOutcomes?.has(snapshot.id)) throw new Error('Outcome not recorded')
  } else {
    await withFileLock(
      `${target}.lock`,
      async () => {
        const count = Number(await readFile(target, 'utf8'))
        await Bun.sleep(2)
        await writeFile(target, String(count + 1))
      },
      { timeoutMs: 10_000, staleMs: 600_000 },
    )
  }
}

await flushJournal()

restoreEnv('OCTONOESIS_MEMORY_DIR', originalMemoryDir)

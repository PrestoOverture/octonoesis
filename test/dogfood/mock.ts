/** Scripted provider, running the real headless query/tools/episode/distillation path keylessly. */
import { randomUUID } from 'node:crypto'
import { DEFAULT_CONFIG } from '../../src/config/schema'
import { runJsonQuery } from '../../src/headless'
import { initializeMemoryAvailability } from '../../src/memory/availability'
import { configureOneShotPermissions } from '../../src/permissions/confirm'
import { setProvider } from '../../src/providers'
import type { LLMProvider, StreamEvent } from '../../src/providers/types'
import { families, partialSolution, solutions, taskSchema } from './tasks'

async function main(): Promise<void> {
  const task = taskSchema.parse(JSON.parse(process.argv[2] as string))
  const errorClass = `${task.family.replace(/(^|-)(\w)/g, (_, _p, c: string) => c.toUpperCase())}Error`
  // The mock observes actual injected advice. It is never given the arm label or oracle.
  const scriptedFailure = Math.floor(task.seed / families.length) % 2 !== 0
  let turn = 0
  let helped = false
  let partial = false
  const provider: LLMProvider = {
    name: 'openai-compatible',
    async *createMessageStream(messages, tools, opts): AsyncGenerator<StreamEvent> {
      const text = JSON.stringify(messages)
      let answer: unknown
      if (text.includes('precise tool execution error analyzer'))
        answer = { tool: 'bun-test', error_class: errorClass, file: '', expression: '' }
      else if (text.includes('expert software engineering mentor'))
        answer = {
          slug: task.family,
          triggers: {
            tools: ['Bash'],
            command_prefix: ['bun test'],
            error_signatures: [`bun-test|${errorClass}`],
          },
          anchor_file: 'src/subject.ts',
          advice: `Remember ${task.family}: verify generation ownership, atomic invariants, and all boundary cases.`,
        }
      else if (tools.length === 0) answer = []
      else {
        helped ||= `${opts.system}\n${text}`.includes(`Remember ${task.family}:`)
        const step = turn++
        if (step === 2) partial = !helped && scriptedFailure
        const tool =
          step === 0
            ? { name: 'Read', input: { path: 'src/subject.ts' } }
            : step === 1
              ? { name: 'Bash', input: { command: 'bun test' } }
              : step === 2
                ? {
                    name: 'Write',
                    input: {
                      path: 'src/subject.ts',
                      content:
                        helped || !scriptedFailure
                          ? solutions[task.family]
                          : partialSolution(task.family),
                    },
                  }
                : step === 3
                  ? { name: 'Bash', input: { command: 'bun test' } }
                  : step === 4 && partial
                    ? {
                        name: 'Write',
                        input: { path: 'src/subject.ts', content: solutions[task.family] },
                      }
                    : step === 5 && partial
                      ? { name: 'Bash', input: { command: 'bun test' } }
                      : undefined
        if (tool) yield { type: 'tool_use', id: `call-${step}`, ...tool }
        else
          yield { type: 'text_delta', text: 'Completed the implementation and local verification.' }
        yield {
          type: 'message_end',
          usage: { input_tokens: 100, output_tokens: 30 },
          stopReason: tool ? 'tool_use' : 'end_turn',
        }
        return
      }
      yield { type: 'text_delta', text: JSON.stringify(answer) }
      yield {
        type: 'message_end',
        usage: { input_tokens: 50, output_tokens: 20 },
        stopReason: 'end_turn',
      }
    },
  }
  setProvider(provider)
  const memoryDir = process.env.OCTONOESIS_MEMORY_DIR as string
  await initializeMemoryAvailability(memoryDir)
  configureOneShotPermissions('bypass', process.stderr)
  await runJsonQuery(task.prompt, {
    repoRoot: process.cwd(),
    memoryDir,
    sessionId: randomUUID(),
    config: DEFAULT_CONFIG,
  })
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })

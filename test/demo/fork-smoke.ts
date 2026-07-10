import { forkAgent } from '../../src/providers/fork'

if (process.argv.includes('--fork-child')) {
  const { forkChildMain } = await import('../../src/providers/forkChild.ts')
  process.exit(await forkChildMain())
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required to run the fork smoke test')
  }

  process.env.LLM_PROVIDER = 'anthropic'
  Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_DEPTH')
  Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_MOCK')

  const result = await forkAgent({
    systemPrompt: 'You are a concise summarizer. Return only the summary.',
    messages: [
      {
        role: 'user',
        content:
          'Octonoesis keeps an append-only observation ledger, derives replayable episodes and rules from external evidence, and compiles only relevant context for each coding task. Its core principle is that language models may interpret evidence, while the harness alone authorizes actions and changes in autonomy.',
      },
    ],
    tools: [],
    maxTurns: 1,
    forkPurpose: 'compact',
  })

  if (result.exitReason !== 'completed') {
    throw new Error(result.error ?? `Fork exited with ${result.exitReason}`)
  }

  console.log(`Text: ${result.text}`)
  console.log(`Usage: ${JSON.stringify(result.usage)}`)
  console.log(`Turns: ${result.turns}`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

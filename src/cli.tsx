#!/usr/bin/env bun
import { Command } from 'commander'
import { render } from 'ink'
import React from 'react'
import { runQuery } from './query'
import { App } from './ui/App'

function checkApiKey(): void {
  const provider = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase()
  if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      'Error: ANTHROPIC_API_KEY is not set.\n\n' +
        'Set it in your environment:\n' +
        '  export ANTHROPIC_API_KEY=sk-ant-...\n\n' +
        'Or switch to OpenAI:\n' +
        '  export LLM_PROVIDER=openai\n' +
        '  export OPENAI_API_KEY=sk-proj-...',
    )
    process.exit(1)
  }
  if (provider === 'openai' && !process.env.OPENAI_API_KEY) {
    console.error(
      'Error: OPENAI_API_KEY is not set.\n\n' +
        'Set it in your environment:\n' +
        '  export OPENAI_API_KEY=sk-proj-...',
    )
    process.exit(1)
  }
}

const program = new Command()

program
  .name('octonoesis')
  .description('An open-source terminal coding agent')
  .version('0.1.0')
  .argument('[prompt]', 'One-shot prompt to send to the model')
  .action(async (prompt?: string) => {
    checkApiKey()

    if (!prompt) {
      const { waitUntilExit } = render(<App />, { exitOnCtrlC: false })
      await waitUntilExit()
      return
    }

    try {
      await runQuery(prompt)
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`)
        process.exit(1)
      }
      throw error
    }
  })

program.parse(process.argv)

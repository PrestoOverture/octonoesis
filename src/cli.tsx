import path from 'node:path'
import { Command } from 'commander'
import { render } from 'ink'
import React from 'react'
import { rebuildRules } from './memory/rules/rebuild.ts'
import { getRulesDir } from './memory/rules/store.ts'
import { getResolvedModel } from './providers/index.ts'
import { runQuery } from './query'
import { App } from './ui/App'
import { getMemoryDir } from './utils/path.ts'

const program = new Command()

program.name('octonoesis').description('An open-source terminal coding agent').version('0.0.1')

program
  .command('rebuild-rules')
  .description('Rebuild active rules from segmented episodes')
  .option('--force', 'Force re-distillation of all rules via LLM')
  .action(async (options) => {
    try {
      const memoryDir = getMemoryDir()
      const episodesPath = path.join(memoryDir, 'episodes.jsonl')
      const rulesDir = getRulesDir()
      const model = getResolvedModel()

      console.log('Rebuilding rules from episodes...')
      await rebuildRules(episodesPath, rulesDir, {
        model,
        extractorVersion: '0.2.0',
        forceDistill: !!options.force,
      })
      console.log('Rules successfully rebuilt!')
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error rebuilding rules: ${error.message}`)
        process.exit(1)
      }
      throw error
    }
  })

program
  .argument('[prompt]', 'One-shot prompt to send to the model')
  .action(async (prompt?: string) => {
    if (!prompt) {
      // Launch interactive Ink TUI mode
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

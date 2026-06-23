#!/usr/bin/env bun
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

program.name('octonoesis').description('An open-source terminal coding agent').version('0.1.0')

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
  .command('stats')
  .description('Display calibration statistics')
  .action(async () => {
    try {
      const { readCalibrationRecords, aggregateCalibrationStats } = await import(
        './memory/calibration/stats.ts'
      )
      const { formatStatsTable } = await import('./memory/calibration/format.ts')
      const records = await readCalibrationRecords()
      const statsList = aggregateCalibrationStats(records)
      console.log(formatStatsTable(statsList))
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error displaying stats: ${error.message}`)
        process.exit(1)
      }
      throw error
    }
  })

program
  .option('--stats', 'Display calibration statistics')
  .option('--debug', 'Enable debug logging')
  .argument('[prompt]', 'One-shot prompt to send to the model')
  .action(async (prompt?: string) => {
    checkApiKey()

    if (program.opts().stats) {
      try {
        const { readCalibrationRecords, aggregateCalibrationStats } = await import(
          './memory/calibration/stats.ts'
        )
        const { formatStatsTable } = await import('./memory/calibration/format.ts')
        const records = await readCalibrationRecords()
        const statsList = aggregateCalibrationStats(records)
        console.log(formatStatsTable(statsList))
        return
      } catch (error) {
        if (error instanceof Error) {
          console.error(`Error displaying stats: ${error.message}`)
          process.exit(1)
        }
        throw error
      }
    }

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

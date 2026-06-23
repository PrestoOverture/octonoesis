#!/usr/bin/env bun
import { Command } from 'commander'
import { render } from 'ink'
import React from 'react'
import { runQuery } from './query'
import { App } from './ui/App'

const program = new Command()

program
  .name('octonoesis')
  .description('An open-source terminal coding agent')
  .version('0.0.1')
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

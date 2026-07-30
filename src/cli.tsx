#!/usr/bin/env bun
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Command } from 'commander'
import { render } from 'ink'
import React from 'react'
import { getConfigTrustWarning, loadConfig } from './config/load.ts'
import type { OctonoesisConfig } from './config/schema.ts'
import { appendExperimentRecord, readExperiments } from './experiments/registry.ts'
import type { ExperimentRecord } from './experiments/schema.ts'
import { rebuildRules } from './memory/rules/rebuild.ts'
import { getRulesDir } from './memory/rules/store.ts'
import { getResolvedModel, setConfiguredModel } from './providers/index.ts'
import { type ToolContext, runQuery } from './query'
import type { SessionState } from './query/types.ts'
import { assertSandboxAvailable, resolveSandboxConfig } from './sandbox/manager.ts'
import type { ResolvedSandboxConfig } from './sandbox/types.ts'
import { rewriteSkillSlashCommand } from './skills/execute.ts'
import { createSessionState, flushSessionStats, formatSessionSummary } from './state/session.ts'
import {
  type StoredSession,
  formatSessionList,
  listSessions,
  loadMostRecentSession,
  loadSession,
} from './state/sessionStore.ts'
import { cleanupTasks } from './tasks/framework.ts'
import { App } from './ui/App'
import { dbg } from './utils/debug.ts'
import { hasAnthropicKey, hasOpenAIKey } from './utils/env.ts'
import { getMemoryDir, getRepoRoot } from './utils/path.ts'

if (process.argv.includes('--fork-child')) {
  const { forkChildMain } = await import('./providers/forkChild.ts')
  process.exit(await forkChildMain())
}

const startupRepoRoot = getRepoRoot()
let startupConfig: OctonoesisConfig
try {
  startupConfig = await loadConfig(startupRepoRoot)
  setConfiguredModel(startupConfig.model)
  const trustWarning = await getConfigTrustWarning(startupRepoRoot, startupConfig)
  if (trustWarning) console.error(trustWarning)
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

/**
 * Validates that the necessary API key environment variables are set.
 * Exits the process if the required key for the configured provider is missing.
 */

function checkApiKey(): void {
  const provider = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase()
  if (provider === 'anthropic' && !hasAnthropicKey()) {
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
  if (provider === 'openai' && !hasOpenAIKey()) {
    console.error(
      'Error: OPENAI_API_KEY is not set.\n\n' +
        'Set it in your environment:\n' +
        '  export OPENAI_API_KEY=sk-proj-...',
    )
    process.exit(1)
  }
}

function truncate(text: string, limit: number): string {
  const characters = Array.from(text)
  return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : text
}

function formatExperimentList(experiments: ExperimentRecord[]): string {
  if (experiments.length === 0) return 'No registered experiments.'
  const headers = ['ID', 'Status', 'Arms', 'Registered', 'Hypothesis']
  const rows = experiments.map((experiment) => [
    experiment.id,
    experiment.status,
    String(experiment.arms?.length ?? 0),
    experiment.registered_at,
    truncate(experiment.hypothesis, 60),
  ])
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)),
  )
  const renderRow = (row: string[]) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
      .join('  ')
      .trimEnd()
  return [
    renderRow(headers),
    renderRow(widths.map((width) => '-'.repeat(width))),
    ...rows.map(renderRow),
  ].join('\n')
}

const program = new Command()

program.name('octonoesis').description('An open-source terminal coding agent').version('1.1.0')

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
  .command('dashboard')
  .description('Display learning-loop fitness from local ledger files')
  .option('--json', 'Emit versioned machine-readable JSON')
  .option('--weeks <N>', 'Limit trends to the trailing N ISO weeks')
  .option('--bucket <coarse>', 'Filter cost episodes by coarse fingerprint bucket')
  .action(async (options) => {
    try {
      const weeks = options.weeks === undefined ? undefined : Number(options.weeks)
      if (weeks !== undefined && (!Number.isInteger(weeks) || weeks < 1)) {
        throw new Error('--weeks must be a positive integer')
      }
      const { renderFitnessDashboard } = await import('./memory/fitness/run.ts')
      console.log(
        await renderFitnessDashboard({
          json: options.json === true,
          ...(weeks === undefined ? {} : { weeks }),
          ...(options.bucket === undefined ? {} : { bucket: options.bucket }),
        }),
      )
    } catch (error) {
      console.error(
        `Error displaying dashboard: ${error instanceof Error ? error.message : String(error)}`,
      )
      process.exit(1)
    }
  })

program
  .command('sessions')
  .description('List saved sessions for this repository')
  .action(async () => {
    try {
      const sessions = await listSessions({
        memoryDir: getMemoryDir(),
        repoRoot: startupRepoRoot,
      })
      console.log(formatSessionList(sessions))
    } catch (error) {
      console.error(
        `Error listing sessions: ${error instanceof Error ? error.message : String(error)}`,
      )
      process.exit(1)
    }
  })

program
  .command('experiments')
  .description('List preregistered experiments, or register one with --register <jsonFile>')
  .option('--register <jsonFile>', 'Register a new experiment from a JSON file')
  .option('--running', 'Register with status "running" instead of "registered" (with --register)')
  .action(async (options) => {
    try {
      if (options.register) {
        const raw: unknown = JSON.parse(await fs.readFile(options.register, 'utf8'))
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new Error(`${options.register} must contain a JSON object`)
        }
        const saved = await appendExperimentRecord({
          ...raw,
          schema_version: 1,
          registered_at: new Date().toISOString(),
          status: options.running ? 'running' : 'registered',
        })
        console.log(`Registered experiment ${saved.id} (status: ${saved.status}).`)
        return
      }

      console.log(formatExperimentList(await readExperiments()))
    } catch (error) {
      console.error(
        `Error with experiments: ${error instanceof Error ? error.message : String(error)}`,
      )
      process.exit(1)
    }
  })

program
  .option('--stats', 'Display calibration statistics')
  .option('--debug', 'Enable debug logging')
  .option('--sandbox', 'Run Bash tool commands inside macOS sandbox-exec')
  .option('-c, --continue', 'Resume the most recent saved session for this repository')
  .option('--resume <sessionId>', 'Resume a specific saved session')
  .option('--save-session', 'Persist this one-shot session for later resume')
  .argument('[prompt]', 'One-shot prompt to send to the model')
  .action(async (prompt?: string) => {
    const options = program.opts()
    const memoryDir = getMemoryDir()
    let resumedSession: StoredSession | undefined
    try {
      if (options.continue && options.resume) {
        throw new Error('--continue and --resume cannot be used together')
      }
      if (options.resume) {
        resumedSession = await loadSession(String(options.resume), { memoryDir })
      } else if (options.continue) {
        resumedSession = (await loadMostRecentSession(startupRepoRoot, { memoryDir })) ?? undefined
        if (!resumedSession) {
          throw new Error(`No saved sessions found for ${startupRepoRoot}`)
        }
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }

    let sandbox: ResolvedSandboxConfig | undefined
    try {
      const resolved = resolveSandboxConfig({
        repoRoot: startupRepoRoot,
        cliEnabled: program.opts().sandbox,
        config: startupConfig.sandbox,
      })
      if (resolved.enabled) {
        sandbox = resolved
        assertSandboxAvailable()
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
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
      let latestSession: { sessionState: SessionState; priced: boolean } | undefined
      const sessionId = crypto.randomUUID()
      const tuiCtx: ToolContext = {
        repoRoot: startupRepoRoot,
        memoryDir,
        persistSession:
          process.stdin.isTTY === true ||
          resumedSession !== undefined ||
          options.saveSession === true,
        messages: structuredClone(resumedSession?.messages ?? []),
        sessionId,
        sessionState: createSessionState(sessionId, getResolvedModel()),
        sandbox,
        config: startupConfig,
        tasks: new Map(),
      }
      const { waitUntilExit } = render(
        <App
          ctx={tuiCtx}
          resumeInfo={
            resumedSession
              ? {
                  sessionId: resumedSession.session_id,
                  messageCount: resumedSession.messages.length,
                  updatedAt: resumedSession.updated_at,
                }
              : undefined
          }
          onSessionState={(sessionState, priced) => {
            latestSession = { sessionState, priced }
          }}
        />,
        { exitOnCtrlC: false },
      )
      await waitUntilExit()
      try {
        await cleanupTasks(tuiCtx)
      } catch (error) {
        dbg('cli', 'Failed to clean up background tasks', error)
      }
      await flushSessionStats()
      if (latestSession) {
        console.log(formatSessionSummary(latestSession.sessionState, latestSession.priced))
      }
      return
    }

    try {
      await runQuery(
        await rewriteSkillSlashCommand(prompt, startupRepoRoot),
        sandbox,
        startupConfig,
        {
          memoryDir,
          messages: resumedSession?.messages,
          persistSession:
            resumedSession !== undefined ||
            options.continue === true ||
            options.resume !== undefined ||
            options.saveSession === true,
        },
      )
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`)
        process.exit(1)
      }
      throw error
    }
  })

program.parse(process.argv)

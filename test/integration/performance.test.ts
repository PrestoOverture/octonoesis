import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { setProvider } from '../../src/providers'
import type { StreamEvent as ProviderStreamEvent } from '../../src/providers/types'
import { query } from '../../src/query'
import type { StreamEvent } from '../../src/query'
import { MockProvider } from '../utils/mockProvider'

describe('Performance Latency Verification', () => {
  it('verifies CLI cold start latency is <= 1.5s', () => {
    const runs = 5
    const durations: number[] = []

    for (let i = 0; i < runs; i++) {
      const start = performance.now()
      const proc = spawnSync('bun', ['src/cli.tsx', '--version'], {
        cwd: resolve('.'),
        encoding: 'utf-8',
      })
      const end = performance.now()

      expect(proc.status).toBe(0)
      expect(proc.stdout.trim()).toBe('0.0.1')
      durations.push(end - start)
    }

    // Sort durations to find the median
    durations.sort((a, b) => a - b)
    const median = durations[Math.floor(runs / 2)] ?? 0

    console.log(`Cold start median latency: ${median.toFixed(2)}ms`)
    expect(median < 1500).toBe(true) // 1.5 seconds
  })

  it('verifies first token latency with mock provider is <= 3s', async () => {
    const turnEvents: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'Hello world' },
      { type: 'message_end', usage: { input_tokens: 5, output_tokens: 5 } },
    ]

    const mockProvider = new MockProvider([turnEvents])
    setProvider(mockProvider)

    const start = performance.now()
    const generator = query('say hello', { repoRoot: resolve('.') })

    let firstTokenTime = 0
    for await (const event of generator) {
      if (event.type === 'text_delta' && firstTokenTime === 0) {
        firstTokenTime = performance.now()
        break // We only need the first token
      }
    }

    const firstTokenLatency = firstTokenTime - start
    console.log(`First token latency (mock): ${firstTokenLatency.toFixed(2)}ms`)

    expect(firstTokenTime > 0).toBe(true)
    expect(firstTokenLatency < 3000).toBe(true) // 3.0 seconds

    // Reset provider
    setProvider(null)
  })
})

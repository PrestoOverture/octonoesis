declare const Bun: {
  serve(options: { port: number; fetch(request: Request): Promise<Response> }): {
    port: number
    stop(closeActiveConnections?: boolean): void
  }
}

import { afterEach, expect, test } from 'bun:test'
import {
  getCheapestModel,
  getProvider,
  getResolvedModel,
  setConfiguredModel,
  setProvider,
} from '../../../src/providers'
import { shellChildEnv } from '../../../src/utils/childEnv'
import {
  captureProviderCredentials,
  getProviderCredentialEnvironment,
  getSparkKey,
  setProviderCredentialsForTests,
} from '../../../src/utils/env'
import { restoreEnv } from '../../helpers/env'

const originalEnv = Object.fromEntries(
  ['LLM_PROVIDER', 'MODEL', 'SPARK_MODEL', 'SPARK_BASE_URL'].map((key) => [key, process.env[key]]),
)
const credentials = getProviderCredentialEnvironment()

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) restoreEnv(key, value)
  setProviderCredentialsForTests(credentials)
  setProvider(null)
  setConfiguredModel(undefined)
})

test('Spark is the default for main and auxiliary requests with model overrides', () => {
  for (const key of ['LLM_PROVIDER', 'MODEL', 'SPARK_MODEL'])
    Reflect.deleteProperty(process.env, key)
  setConfiguredModel(undefined)
  expect(getResolvedModel()).toBe('spark-x2.6')
  expect(getCheapestModel()).toBe('spark-x2.6')
  setConfiguredModel('configured-spark')
  expect(getResolvedModel()).toBe('configured-spark')
  process.env.SPARK_MODEL = 'custom-spark'
  expect(getResolvedModel()).toBe('custom-spark')
  expect(getCheapestModel()).toBe('custom-spark')
  process.env.MODEL = 'global-model'
  expect(getResolvedModel()).toBe('global-model')
  expect(getCheapestModel()).toBe('custom-spark')
})

test('Spark credentials are captured and removed from child environment sources', () => {
  const source = { SPARK_API_KEY: 'spark-test-key' }
  captureProviderCredentials(source)
  expect(source).toEqual({})
  expect(getSparkKey()).toBe('spark-test-key')
  expect(shellChildEnv({ SPARK_API_KEY: 'spark-test-key', PATH: '/bin' })).toEqual({ PATH: '/bin' })
  expect(getProviderCredentialEnvironment()).toEqual({ SPARK_API_KEY: 'spark-test-key' })
  setProviderCredentialsForTests({})
  expect(() => getSparkKey()).toThrow('SPARK_API_KEY is not set')
})

test('default and explicit Spark requests disable thinking and normalize streaming tools', async () => {
  const requests: unknown[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe('/v2/chat/completions')
      expect(request.headers.get('authorization')).toBe('Bearer spark-test-key')
      const body = await request.json()
      requests.push(body)
      expect(body.thinking).toEqual({ type: 'disabled' })
      expect(body.model).toBe('spark-x2.6')
      expect(body.stream).toBe(true)
      expect(body.stream_options).toEqual({ include_usage: true })
      const chunks = [
        { choices: [{ delta: { content: 'OK' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'probe', arguments: '{"ok":true}' } },
                ],
              },
            },
          ],
        },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ]
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
        {
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    },
  })
  try {
    setProviderCredentialsForTests({ SPARK_API_KEY: 'spark-test-key' })
    process.env.SPARK_BASE_URL = `http://127.0.0.1:${server.port}/v2`
    for (const mode of [undefined, 'spark']) {
      restoreEnv('LLM_PROVIDER', mode)
      setProvider(null)
      const events = []
      for await (const event of getProvider().createMessageStream(
        [{ role: 'user', content: 'probe' }],
        [{ name: 'probe', description: 'Probe', inputSchema: { type: 'object' } }],
        { model: 'spark-x2.6', maxTokens: 64, signal: AbortSignal.timeout(5000) },
      ))
        events.push(event)
      expect(events).toEqual([
        { type: 'text_delta', text: 'OK' },
        { type: 'tool_use', id: 'call_1', name: 'probe', input: { ok: true } },
        { type: 'message_end', stopReason: 'other', usage: { input_tokens: 10, output_tokens: 5 } },
      ])
    }
    expect(requests.length).toBe(2)
  } finally {
    server.stop(true)
  }
})

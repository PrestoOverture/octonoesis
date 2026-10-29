import { expect, test } from 'bun:test'
import { type EvalResult, classify, command, evaluate, exitCode, summarize } from '../eval/run'

const ok = { code: 0, stdout: '', stderr: '', timed_out: false }
const failed = { ...ok, code: 1 }
const killed = { ...ok, code: 143, signal: 'SIGTERM' }
const timeout = { ...killed, timed_out: true }
const row = (status: EvalResult['status'], turns = 1): EvalResult => ({
  task: 'task',
  repetition: 1,
  status,
  passed: status === 'PASS',
  duration_ms: 1000,
  output: {
    turns,
    usage: { input_tokens: 0, output_tokens: turns * 10 },
    duration_ms: turns * 1000,
    exit_reason: 'completed',
    tool_calls: [],
    final_text: '',
    session_id: 'test',
  },
})

test('classifies failures, unsolicited signals, invalid output and runner timeouts', () => {
  expect(classify(ok, ok)).toBe('PASS')
  expect(classify(failed, failed)).toBe('FAIL')
  expect(classify(failed, ok)).toBe('PASS')
  expect(classify(killed, failed)).toBe('ERROR')
  expect(classify(killed, ok)).toBe('ERROR')
  expect(classify(timeout, ok)).toBe('PASS')
  expect(classify(timeout, failed, false)).toBe('FAIL')
  expect(classify(ok, ok, false)).toBe('FAIL')
  expect(classify(ok, killed)).toBe('ERROR')
  expect(classify(ok, timeout)).toBe('FAIL')
})

test('trapped external signals and user cancellation are infrastructure errors', () => {
  for (const code of [128, 129, 130, 143, 255]) {
    const trapped = { ...ok, code, signal: null }
    expect(classify(trapped, failed, true, 'user_cancel')).toBe('ERROR')
    expect(classify(trapped, ok, true, 'completed')).toBe('ERROR')
    expect(classify(trapped, failed, false)).toBe('ERROR')
  }
  expect(classify(ok, ok, true, 'user_cancel')).toBe('ERROR')
  expect(classify(ok, failed, true, 'user_cancel')).toBe('ERROR')
})

test('normal CLI exits with invalid output remain agent failures', () => {
  for (const code of [0, 1, 127]) {
    expect(classify({ ...ok, code }, ok, false)).toBe('FAIL')
    expect(classify({ ...ok, code }, failed, false)).toBe('FAIL')
  }
})

test('runner timeouts preserve check-based partial-attempt credit', () => {
  for (const cli of [timeout, { ...timeout, signal: null }]) {
    expect(classify(cli, ok, false)).toBe('PASS')
    expect(classify(cli, ok, true, 'user_cancel')).toBe('PASS')
    expect(classify(cli, failed, true, 'user_cancel')).toBe('FAIL')
    expect(classify(cli, timeout)).toBe('FAIL')
  }
})

test('real command signal differs from a runner timeout', async () => {
  const signal = await command(['bash', '-c', 'kill -TERM $$'], process.cwd(), process.env, 5000)
  expect(signal.signal).toBe('SIGTERM')
  expect(classify(signal, failed)).toBe('ERROR')
  const deadline = await command(['bash', '-c', 'sleep 10'], process.cwd(), process.env, 30)
  expect(deadline.timed_out).toBe(true)
  expect(classify(deadline, failed)).toBe('FAIL')
})

test('evaluate records clear diagnostics for every external termination', async () => {
  for (const cli of [
    { ...killed, stdout: JSON.stringify(row('PASS').output) },
    {
      ...ok,
      code: 143,
      signal: null,
      stdout: JSON.stringify({ ...row('PASS').output, exit_reason: 'user_cancel' }),
    },
    { ...ok, stdout: JSON.stringify({ ...row('PASS').output, exit_reason: 'user_cancel' }) },
  ]) {
    let calls = 0
    const result = await evaluate(
      'off-by-one',
      { prompt: 'unused', check: 'unused', timeout_s: 1 },
      1,
      undefined,
      async () => (++calls === 4 ? cli : ok),
    )
    expect(result.status).toBe('ERROR')
    expect(result.passed).toBe(false)
    expect(result.error).toContain('CLI terminated externally')
    expect(result.error).toContain(`code ${cli.code}`)
    expect(result.error).toContain('exit_reason')
  }
  let calls = 0
  const result = await evaluate(
    'off-by-one',
    { prompt: 'unused', check: 'unused', timeout_s: 1 },
    1,
    undefined,
    async () =>
      ++calls === 4
        ? { ...ok, stdout: JSON.stringify(row('PASS').output) }
        : calls === 5
          ? killed
          : ok,
  )
  expect(result.status).toBe('ERROR')
  expect(result.error).toContain('Check terminated externally')
})

test('exit codes prioritize FAIL over ERROR', () => {
  expect(exitCode([])).toBe(0)
  expect(exitCode([row('PASS')])).toBe(0)
  expect(exitCode([row('ERROR')])).toBe(2)
  expect(exitCode([row('ERROR'), row('FAIL')])).toBe(1)
})

test('summary counts, pass denominator and odd/even medians exclude errors', () => {
  const rows = [row('PASS', 2), row('FAIL', 4), row('ERROR', 100)]
  expect(summarize(rows)).toEqual({
    tasks: { task: { pass: 1, fail: 1, error: 1 } },
    pass_rate: 0.5,
    median_turns: 3,
    median_output_tokens: 30,
    median_seconds: 3,
  })
  expect(summarize([...rows, row('PASS', 9)]).median_turns).toBe(4)
  expect(summarize([row('ERROR')]).pass_rate).toBe(null)
  expect(summarize([]).median_turns).toBe(null)
  const missing = row('FAIL')
  missing.output = undefined
  expect(summarize([missing]).median_turns).toBe(null)
  expect(summarize([missing]).median_seconds).toBe(1)
  const other = { ...row('PASS'), task: 'other' }
  expect(summarize([...rows, other]).tasks.other).toEqual({ pass: 1, fail: 0, error: 0 })
})

import { expect, test } from 'bun:test'
import { type EvalResult, classify, command, exitCode, summarize } from '../eval/run'

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
  expect(classify(timeout, ok)).toBe('FAIL')
  expect(classify(timeout, failed, false)).toBe('FAIL')
  expect(classify(ok, ok, false)).toBe('ERROR')
  expect(classify(ok, killed)).toBe('ERROR')
  expect(classify(ok, timeout)).toBe('FAIL')
})

test('real command signal differs from a runner timeout', async () => {
  const signal = await command(['bash', '-c', 'kill -TERM $$'], process.cwd(), process.env, 5000)
  expect(signal.signal).toBe('SIGTERM')
  expect(classify(signal, failed)).toBe('ERROR')
  const deadline = await command(['bash', '-c', 'sleep 10'], process.cwd(), process.env, 30)
  expect(deadline.timed_out).toBe(true)
  expect(classify(deadline, failed)).toBe('FAIL')
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

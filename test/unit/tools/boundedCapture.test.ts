import { expect, test } from 'bun:test'
import { BoundedCapture, captureStream } from '../../../src/tools/boundedCapture'

test('capture retains only its fixed head and rolling tail budget over a 200MB stream', async () => {
  const budget = 30_000
  const capture = new BoundedCapture(budget)
  const chunk = new TextEncoder().encode('x'.repeat(64 * 1024))
  let remaining = 200 * 1024 * 1024
  let spilled = 0
  let maximumRetained = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining === 0) return controller.close()
      controller.enqueue(chunk)
      remaining -= chunk.length
    },
  })
  await captureStream(stream, capture, async (bytes) => {
    spilled += bytes.length
    maximumRetained = Math.max(maximumRetained, capture.retainedChars)
    expect(capture.retainedChars <= budget).toBe(true)
    expect(capture.capacityBytes).toBe(budget * 2)
  })
  expect(spilled).toBe(200 * 1024 * 1024)
  expect(maximumRetained).toBe(budget)
  expect(capture.truncated).toBe(true)
  expect(capture.text().length <= budget).toBe(true)
})

test('head/tail capture is independent of chunk boundaries and preserves exact short output', () => {
  for (const width of [1, 3, 49, 50, 51, 100, 1000]) {
    const capture = new BoundedCapture(100)
    const input = Array.from({ length: 1000 }, (_, i) => String.fromCharCode(33 + (i % 90))).join(
      '',
    )
    for (let i = 0; i < input.length; i += width) capture.append(input.slice(i, i + width))
    const preview = capture.text()
    expect(preview.length).toBe(100)
    expect(preview.startsWith(input.slice(0, 20))).toBe(true)
    expect(preview.endsWith(input.slice(-50))).toBe(true)
  }
  for (const length of [0, 1, 50, 51, 100]) {
    const capture = new BoundedCapture(100)
    capture.append('x'.repeat(length))
    expect(capture.truncated).toBe(false)
    expect(capture.text()).toBe('x'.repeat(length))
  }
})

test('stream decoding preserves UTF-8 split across byte chunks', async () => {
  const bytes = new TextEncoder().encode('hello 世界 😀\n')
  const capture = new BoundedCapture(100)
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === bytes.length) return controller.close()
      controller.enqueue(bytes.subarray(index, ++index))
    },
  })
  await captureStream(stream, capture, async () => {})
  expect(capture.text()).toBe('hello 世界 😀\n')
})

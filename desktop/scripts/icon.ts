// Regenerates icon.iconset from the Noe pixel-art SVG: a dark macOS squircle with Noe centred.
// Needs ffmpeg (raw RGBA → PNG) and sips. Run: bun scripts/icon.ts
import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const svg = await Bun.file(here('../src/mainview/assets/noe-f11.svg')).text()
const grid = Number(svg.match(/viewBox="0 0 (\d+) \d+"/)?.[1])
const rects = [
  ...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="1" height="1" fill="#([0-9A-Fa-f]{6})"\/>/g),
].map(([, x, y, hex]) => ({ x: Number(x), y: Number(y), rgb: hex as string }))
if (!grid || !rects.length) throw new Error('Unexpected noe-f11.svg format')

const SIZE = 1024
const BODY = 824 // Apple's icon grid: 100px margin around the squircle.
const CELL = 20
const pixels = new Uint8Array(SIZE * SIZE * 4)
const set = (x: number, y: number, [r, g, b]: number[], a: number) => {
  const i = (y * SIZE + x) * 4
  pixels.set([r as number, g as number, b as number, Math.round(a * 255)], i)
}
const mix = (top: number[], bottom: number[], t: number) =>
  top.map((value, i) => Math.round(value + ((bottom[i] as number) - value) * t))

// Superellipse |x|^5 + |y|^5 = 1 approximates the continuous-corner squircle; 4×4 supersampling.
const half = BODY / 2
for (let y = 0; y < SIZE; y++)
  for (let x = 0; x < SIZE; x++) {
    let inside = 0
    for (let sy = 0; sy < 4; sy++)
      for (let sx = 0; sx < 4; sx++) {
        const u = Math.abs((x + (sx + 0.5) / 4 - SIZE / 2) / half)
        const v = Math.abs((y + (sy + 0.5) / 4 - SIZE / 2) / half)
        if (u ** 5 + v ** 5 <= 1) inside++
      }
    if (inside)
      set(x, y, mix([0x23, 0x28, 0x38], [0x0f, 0x11, 0x18], (y - 100) / BODY), inside / 16)
  }
const offset = (SIZE - grid * CELL) / 2
for (const { x, y, rgb } of rects) {
  const color = [0, 2, 4].map((i) => Number.parseInt(rgb.slice(i, i + 2), 16))
  for (let dy = 0; dy < CELL; dy++)
    for (let dx = 0; dx < CELL; dx++) set(offset + x * CELL + dx, offset + y * CELL + dy, color, 1)
}

const out = here('../icon.iconset/')
await rm(out, { recursive: true, force: true })
await mkdir(out)
const raw = `${out}master.rgba`
await Bun.write(raw, pixels)
const run = (argv: string[]) => {
  const result = Bun.spawnSync(argv, { stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`${argv[0]} failed: ${result.stderr.toString()}`)
}
const master = `${out}icon_512x512@2x.png`
run([
  'ffmpeg',
  '-v',
  'error',
  '-f',
  'rawvideo',
  '-pix_fmt',
  'rgba',
  '-s',
  `${SIZE}x${SIZE}`,
  '-i',
  raw,
  master,
])
await rm(raw)
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const name = `${out}icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
    if (name === master) continue
    run(['sips', '-z', String(size * scale), String(size * scale), master, '--out', name])
  }
}
console.log(`wrote ${out}`)

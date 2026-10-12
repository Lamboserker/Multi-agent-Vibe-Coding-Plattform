// Generates build/icon.png (512×512) without external tools: rounded tile + "orchestrator + agents" motif.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const size = 512
const pixels = Buffer.alloc(size * size * 4)
const set = (x, y, [r, g, b, a]) => {
  const index = (y * size + x) * 4
  const alpha = a / 255
  pixels[index] = Math.round(r * alpha + pixels[index] * (1 - alpha))
  pixels[index + 1] = Math.round(g * alpha + pixels[index + 1] * (1 - alpha))
  pixels[index + 2] = Math.round(b * alpha + pixels[index + 2] * (1 - alpha))
  pixels[index + 3] = Math.min(255, pixels[index + 3] + a)
}
const inRoundedRect = (x, y, inset, radius) => {
  const min = inset
  const max = size - inset
  if (x < min || x >= max || y < min || y >= max) return false
  const cx = Math.min(Math.max(x, min + radius), max - radius)
  const cy = Math.min(Math.max(y, min + radius), max - radius)
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
}
const circle = (cx, cy, r, color) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1)
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const d = Math.hypot(x - cx, y - cy)
      if (d <= r + 0.5) set(x, y, [color[0], color[1], color[2], Math.round(255 * Math.min(1, r + 0.5 - d))])
    }
}
const line = (x1, y1, x2, y2, width, color) => {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1))
  for (let i = 0; i <= steps; i += 1) circle(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, width / 2, color)
}

// background tile (dark navy with subtle vertical gradient)
for (let y = 0; y < size; y += 1)
  for (let x = 0; x < size; x += 1)
    if (inRoundedRect(x, y, 24, 96)) {
      const t = y / size
      set(x, y, [Math.round(16 + 10 * t), Math.round(24 + 12 * t), Math.round(36 + 16 * t), 255])
    }

const amber = [229, 165, 75]
const teal = [79, 193, 166]
const violet = [180, 140, 255]
const hub = [256, 196]
const agents = [
  [146, 360],
  [256, 380],
  [366, 360],
]
for (const [x, y] of agents) line(hub[0], hub[1], x, y, 14, [70, 90, 115])
circle(hub[0], hub[1], 70, violet)
circle(hub[0], hub[1], 44, [16, 24, 36])
circle(hub[0], hub[1], 26, amber)
agents.forEach(([x, y], index) => circle(x, y, 34, index === 1 ? amber : teal))

const raw = Buffer.alloc((size * 4 + 1) * size)
for (let y = 0; y < size; y += 1) {
  raw[y * (size * 4 + 1)] = 0
  pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buffer) => {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
const header = Buffer.alloc(13)
header.writeUInt32BE(size, 0)
header.writeUInt32BE(size, 4)
header[8] = 8
header[9] = 6
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png')
mkdirSync(path.dirname(target), { recursive: true })
writeFileSync(target, png)
console.log(`icon → ${target}`)

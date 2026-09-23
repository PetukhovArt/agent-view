import { deflateSync, inflateSync } from 'node:zlib'

export type PixelRect = { x: number; y: number; width: number; height: number }

type Image = { width: number; height: number; rgba: Buffer }

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Crops an 8-bit RGB/RGBA PNG to `rect` (image pixels, clamped to the image)
 * and downscales it by `scale` with an area average. Chromium can do both
 * through `Page.captureScreenshot({ clip })`, but a clip resizes the render
 * view for the capture and restores it only if the capture completes — a
 * hidden window never completes it, so the app stays shrunk.
 */
export function cropScalePng(png: Buffer, rect: PixelRect | undefined, scale: number): Buffer {
  const src = decode(png)
  const x0 = clamp(Math.round(rect?.x ?? 0), 0, src.width - 1)
  const y0 = clamp(Math.round(rect?.y ?? 0), 0, src.height - 1)
  const x1 = clamp(Math.round((rect?.x ?? 0) + (rect?.width ?? src.width)), x0 + 1, src.width)
  const y1 = clamp(Math.round((rect?.y ?? 0) + (rect?.height ?? src.height)), y0 + 1, src.height)
  const width = Math.max(1, Math.round((x1 - x0) * scale))
  const height = Math.max(1, Math.round((y1 - y0) * scale))
  const rgba = Buffer.alloc(width * height * 4)

  for (let y = 0; y < height; y++) {
    const sy0 = y0 + Math.floor((y * (y1 - y0)) / height)
    const sy1 = Math.max(sy0 + 1, y0 + Math.floor(((y + 1) * (y1 - y0)) / height))
    for (let x = 0; x < width; x++) {
      const sx0 = x0 + Math.floor((x * (x1 - x0)) / width)
      const sx1 = Math.max(sx0 + 1, x0 + Math.floor(((x + 1) * (x1 - x0)) / width))
      const sum = [0, 0, 0, 0]
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * src.width + sx) * 4
          for (let c = 0; c < 4; c++) sum[c] += src.rgba[i + c]
        }
      }
      const n = (sy1 - sy0) * (sx1 - sx0)
      const o = (y * width + x) * 4
      for (let c = 0; c < 4; c++) rgba[o + c] = Math.round(sum[c] / n)
    }
  }
  return encode({ width, height, rgba })
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max)
}

function decode(png: Buffer): Image {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG')
  let width = 0
  let height = 0
  let channels = 0
  const idat: Buffer[] = []
  for (let off = 8; off < png.length;) {
    const len = png.readUInt32BE(off)
    const type = png.toString('latin1', off + 4, off + 8)
    const data = png.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const colorType = data[9]
      if (data[8] !== 8 || (colorType !== 2 && colorType !== 6) || data[12] !== 0) {
        throw new Error(`Unsupported PNG: bit depth ${data[8]}, color type ${colorType}, interlace ${data[12]}`)
      }
      channels = colorType === 6 ? 4 : 3
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = y * stride
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[row + i - channels] : 0
      const b = y > 0 ? pixels[row - stride + i] : 0
      const c = i >= channels && y > 0 ? pixels[row - stride + i - channels] : 0
      pixels[row + i] = (line[i] + unfilter(filter, a, b, c)) & 0xff
    }
  }

  if (channels === 4) return { width, height, rgba: pixels }
  const rgba = Buffer.alloc(width * height * 4, 0xff)
  for (let p = 0; p < width * height; p++) pixels.copy(rgba, p * 4, p * 3, p * 3 + 3)
  return { width, height, rgba }
}

function unfilter(filter: number, a: number, b: number, c: number): number {
  switch (filter) {
    case 0: return 0
    case 1: return a
    case 2: return b
    case 3: return (a + b) >> 1
    case 4: {
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
    }
    default: throw new Error(`Unknown PNG filter ${filter}`)
  }
}

function encode({ width, height, rgba }: Image): Buffer {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    // Filter 1 (Sub) — flat UI areas become runs of zeros and deflate well.
    raw[y * (stride + 1)] = 1
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? rgba[y * stride + i - 4] : 0
      raw[y * (stride + 1) + 1 + i] = (rgba[y * stride + i] - left) & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

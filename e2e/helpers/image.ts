import type { BrowserContext, Page } from '@playwright/test'

/** Reads width/height straight out of the PNG's IHDR chunk, no decoder needed. */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.subarray(0, 8).toString('latin1') !== '\x89PNG\r\n\x1a\n') {
    throw new Error('not a PNG')
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

export interface Run {
  color: string
  from: number
  to: number
}

export interface ColorExtent {
  count: number
  minY: number
  maxY: number
}

export interface ImageReport {
  width: number
  height: number
  /** Rows where EVERY pixel has alpha 0 — a hole the stitcher never painted. */
  fullyTransparentRows: number[]
  /** Rows containing ANY pixel with alpha < 255. Stricter; catches partial holes. */
  translucentRows: number[]
  /** Run-length encoding of the colours down a single column. */
  column: Run[]
  /** Where each requested colour occurs, scanned over the whole image. */
  colors: Record<string, ColorExtent>
  /** Colour of the first and last rows at the probe column. */
  firstRow: string
  lastRow: string
}

/**
 * Decodes a PNG and reports on it.
 *
 * The decode happens inside a browser page rather than in Node because Node has
 * no PNG decoder in its standard library, and adding an image dependency to
 * the assertion side of a test that exists to check image correctness is
 * exactly the kind of thing that can quietly agree with a bug. The browser's
 * own decoder is the one the user's image will be read with anyway.
 *
 * Only summaries cross back over the protocol boundary, never pixel arrays.
 */
export async function analyzePng(
  page: Page,
  bytes: Buffer,
  options: { probeX?: number; colors?: string[] } = {},
): Promise<ImageReport> {
  return await page.evaluate(
    async ({ base64, probeX, colors }) => {
      const binary = atob(base64)
      const raw = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) raw[i] = binary.charCodeAt(i)
      const bitmap = await createImageBitmap(new Blob([raw], { type: 'image/png' }))
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('no 2d context')
      // No fill first: the canvas starts fully transparent, so any row the PNG
      // itself leaves transparent stays transparent and is detectable here.
      context.drawImage(bitmap, 0, 0)
      const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height)

      const hex = (offset: number): string =>
        '#' +
        [data[offset], data[offset + 1], data[offset + 2]]
          .map((value) => (value ?? 0).toString(16).padStart(2, '0'))
          .join('')

      const fullyTransparentRows: number[] = []
      const translucentRows: number[] = []
      const targets = new Map<string, { count: number; minY: number; maxY: number }>(
        colors.map((color) => [color.toLowerCase(), { count: 0, minY: -1, maxY: -1 }]),
      )

      for (let y = 0; y < height; y += 1) {
        let opaque = 0
        let translucent = false
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 4
          const alpha = data[offset + 3] ?? 0
          if (alpha === 255) opaque += 1
          else translucent = true
          if (targets.size > 0) {
            const entry = targets.get(hex(offset))
            if (entry) {
              entry.count += 1
              if (entry.minY < 0) entry.minY = y
              entry.maxY = y
            }
          }
        }
        if (opaque === 0) fullyTransparentRows.push(y)
        if (translucent && translucentRows.length < 40) translucentRows.push(y)
      }

      const x = Math.min(probeX, width - 1)
      const column: Array<{ color: string; from: number; to: number }> = []
      for (let y = 0; y < height; y += 1) {
        const color = hex((y * width + x) * 4)
        const last = column[column.length - 1]
        if (last && last.color === color) last.to = y
        else column.push({ color, from: y, to: y })
      }

      return {
        width,
        height,
        fullyTransparentRows: fullyTransparentRows.slice(0, 40),
        translucentRows,
        column,
        colors: Object.fromEntries(targets),
        firstRow: hex(x * 4),
        lastRow: hex(((height - 1) * width + x) * 4),
      }
    },
    {
      base64: bytes.toString('base64'),
      probeX: options.probeX ?? 8,
      colors: options.colors ?? [],
    },
  )
}

/** A blank page used only as a decoder host, kept out of the capture tabs. */
export async function decoderPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  await page.goto('about:blank')
  return page
}

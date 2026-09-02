import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `OffscreenCanvas`/`createImageBitmap`/`fetch` do not exist in the plain
 * Node environment these tests run under (see `tests/offscreen/export-both
 * .test.ts` for the same constraint on `chrome`/`FileReader`). Fakes below
 * stand in for exactly the surface `Stitcher` and `stitcherFromFrame` touch.
 */
class FakeBitmap {
  closed = false
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  close(): void {
    this.closed = true
  }
}

interface DrawCall extends Array<unknown> {
  0: FakeBitmap
}

function stubCanvasEnv(bitmap: FakeBitmap): { drawCalls: DrawCall[] } {
  const drawCalls: DrawCall[] = []

  class FakeContext {
    imageSmoothingEnabled = false
    imageSmoothingQuality = 'low'
    drawImage(...args: unknown[]): void {
      drawCalls.push(args as DrawCall)
    }
  }

  class FakeOffscreenCanvas {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext(): FakeContext {
      return new FakeContext()
    }
    convertToBlob(): Promise<Blob> {
      return Promise.resolve(new Blob(['x']))
    }
  }

  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['x']) })))
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))

  return { drawCalls }
}

describe('stitcherFromFrame', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('with no crop: canvas matches the full decoded frame and draws it whole (unchanged behaviour)', async () => {
    const bitmap = new FakeBitmap(800, 600)
    const { drawCalls } = stubCanvasEnv(bitmap)

    const { stitcherFromFrame } = await import('../../src/offscreen/stitcher')
    const stitcher = await stitcherFromFrame('data:image/png;base64,x')

    expect(stitcher.size).toEqual({ width: 800, height: 600 })
    expect(drawCalls).toHaveLength(1)
    expect(drawCalls[0]).toEqual([bitmap, 0, 0])
    expect(bitmap.closed).toBe(true)
  })

  it('with a crop: plans against the real decoded frame size, sizes the canvas to the crop, and draws only the source rect (nine-arg drawImage)', async () => {
    // This is the real production path (`src/offscreen/index.ts` calls
    // `stitcherFromFrame` with exactly this `{ rect, devicePixelRatio }`
    // shape) -- `planCrop` runs inside `stitcherFromFrame` itself, against
    // the frame it just decoded, not against a value the caller precomputed.
    const bitmap = new FakeBitmap(1600, 1200)
    const { drawCalls } = stubCanvasEnv(bitmap)

    const { stitcherFromFrame } = await import('../../src/offscreen/stitcher')
    const crop = { rect: { x: 10, y: 20, width: 100, height: 50 }, devicePixelRatio: 2 }
    const stitcher = await stitcherFromFrame('data:image/png;base64,x', crop)

    // planCrop({x:10,y:20,width:100,height:50}, 2, {width:1600,height:1200})
    // -> { x: 20, y: 40, width: 200, height: 100 }.
    expect(stitcher.size).toEqual({ width: 200, height: 100 })
    expect(drawCalls).toHaveLength(1)
    expect(drawCalls[0]).toEqual([bitmap, 20, 40, 200, 100, 0, 0, 200, 100])
    expect(bitmap.closed).toBe(true)
  })

  it('rejects without constructing a canvas when planCrop throws (crop outside the frame), and still closes the bitmap', async () => {
    const bitmap = new FakeBitmap(100, 100)
    const { drawCalls } = stubCanvasEnv(bitmap)

    const { stitcherFromFrame } = await import('../../src/offscreen/stitcher')
    const crop = { rect: { x: 5000, y: 5000, width: 10, height: 10 }, devicePixelRatio: 1 }

    await expect(stitcherFromFrame('data:image/png;base64,x', crop)).rejects.toThrow(/empty/i)
    expect(drawCalls).toHaveLength(0)
    expect(bitmap.closed).toBe(true)
  })

  it('closes the bitmap even when drawing throws', async () => {
    const bitmap = new FakeBitmap(100, 100)
    stubCanvasEnv(bitmap)
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext(): never {
          throw new Error('boom')
        }
      },
    )

    const { stitcherFromFrame } = await import('../../src/offscreen/stitcher')
    await expect(stitcherFromFrame('data:image/png;base64,x')).rejects.toThrow('boom')
    expect(bitmap.closed).toBe(true)
  })
})

describe('decodeFrame', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches the data URL and decodes it into a bitmap', async () => {
    const bitmap = new FakeBitmap(50, 60)
    stubCanvasEnv(bitmap)

    const { decodeFrame } = await import('../../src/offscreen/stitcher')
    const result = await decodeFrame('data:image/png;base64,x')

    expect(result).toBe(bitmap)
  })
})

describe('Stitcher.drawBitmapCropped', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('draws the given source rect at the canvas origin', async () => {
    const bitmap = new FakeBitmap(400, 300)
    const { drawCalls } = stubCanvasEnv(bitmap)

    const { Stitcher } = await import('../../src/offscreen/stitcher')
    const stitcher = new Stitcher(120, 80)
    stitcher.drawBitmapCropped(bitmap, { x: 10, y: 15, width: 120, height: 80 })

    expect(drawCalls).toEqual([[bitmap, 10, 15, 120, 80, 0, 0, 120, 80]])
  })
})

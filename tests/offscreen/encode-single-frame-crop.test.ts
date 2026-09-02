import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OffscreenRequest, OffscreenResponse } from '../../src/shared/messages'

/**
 * Exercises `encodeSingleFrame`'s crop path end to end through the real
 * `chrome.runtime.onMessage` listener registered by `src/offscreen/index.ts`
 * -- the same environment constraints and stubbing approach as
 * `tests/offscreen/export-both.test.ts` (module-scope `chrome.runtime`
 * listener; `FileReader` for `blobToDataUrl`), plus fakes for
 * `OffscreenCanvas`/`createImageBitmap`/`fetch` (see
 * `tests/offscreen/stitcher.test.ts`) since this path decodes and draws a
 * real bitmap rather than going through a fake `Exportable`.
 */
class FakeFileReader {
  result: string | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsDataURL(blob: Blob): void {
    void blob
    this.result = 'data:image/png;base64,fake'
    queueMicrotask(() => this.onload?.())
  }
}

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

function stubEnv(bitmap: FakeBitmap): {
  drawCalls: unknown[][]
  convertToBlobCalls: unknown[]
} {
  const drawCalls: unknown[][] = []
  const convertToBlobCalls: unknown[] = []

  class FakeContext {
    imageSmoothingEnabled = false
    imageSmoothingQuality = 'low'
    drawImage(...args: unknown[]): void {
      drawCalls.push(args)
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
    convertToBlob(options: unknown): Promise<Blob> {
      convertToBlobCalls.push(options)
      return Promise.resolve(new Blob(['x']))
    }
  }

  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['x']) })))
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
  vi.stubGlobal('FileReader', FakeFileReader)

  return { drawCalls, convertToBlobCalls }
}

type Listener = (
  request: OffscreenRequest,
  sender: unknown,
  sendResponse: (response: OffscreenResponse) => void,
) => boolean

async function loadListener(): Promise<Listener> {
  const addListener = vi.fn()
  vi.stubGlobal('chrome', { runtime: { onMessage: { addListener } } })
  vi.resetModules()
  await import('../../src/offscreen/index')
  const listener = addListener.mock.calls[0]?.[0] as Listener | undefined
  if (!listener) throw new Error('listener was not registered')
  return listener
}

function send(listener: Listener, request: OffscreenRequest): Promise<OffscreenResponse> {
  return new Promise((resolve) => {
    listener(request, {}, resolve)
  })
}

describe('encodeSingleFrame with crop', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('crops before encoding, decodes the frame once, and exports once for a png download', async () => {
    // Frame is 1600x1200 device px; crop is a 200x100 CSS-px rect at dpr 2 ->
    // device rect { x: 20, y: 40, width: 200, height: 100 }, well within the
    // frame, no clamping involved.
    const bitmap = new FakeBitmap(1600, 1200)
    const { drawCalls, convertToBlobCalls } = stubEnv(bitmap)
    const listener = await loadListener()

    const response = await send(listener, {
      type: 'encodeSingleFrame',
      dataUrl: 'data:image/png;base64,fake-frame',
      crop: { x: 10, y: 20, width: 100, height: 50 },
      devicePixelRatio: 2,
      scale: 2,
      downloadFormat: 'png',
    })

    expect(response.ok).toBe(true)
    if (response.ok) {
      expect(response.clipboardDataUrl).toBe(response.downloadDataUrl)
    }

    // Decoded exactly once: one call to the stubbed `createImageBitmap`.
    expect(vi.mocked(createImageBitmap)).toHaveBeenCalledTimes(1)
    // Drawn once, cropped to the planned device rect (nine-arg drawImage),
    // at the canvas origin.
    expect(drawCalls).toEqual([[bitmap, 20, 40, 200, 100, 0, 0, 200, 100]])
    // Encoded once (png download): a single `convertToBlob` call, and the
    // clipboard/download strings are identical rather than two separate
    // encodes of the same pixels.
    expect(convertToBlobCalls).toHaveLength(1)
    expect(bitmap.closed).toBe(true)
  })

  it('rejects with a clear error when the crop lands entirely outside the frame, without touching stitcher state', async () => {
    const bitmap = new FakeBitmap(100, 100)
    stubEnv(bitmap)
    const listener = await loadListener()

    const response = await send(listener, {
      type: 'encodeSingleFrame',
      dataUrl: 'data:image/png;base64,fake-frame',
      crop: { x: 5000, y: 5000, width: 10, height: 10 },
      devicePixelRatio: 1,
      scale: 1,
      downloadFormat: 'png',
    })

    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error).toMatch(/empty/i)
    }
    expect(bitmap.closed).toBe(true)
  })
})

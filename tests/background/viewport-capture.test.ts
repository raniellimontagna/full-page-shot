import { describe, expect, it, vi } from 'vitest'
import {
  runViewportCapture,
  type ViewportCaptureDeps,
} from '../../src/background/viewport-capture'
import type { OffscreenRequest } from '../../src/shared/messages'

const FRAME = 'data:image/png;base64,FRAME'
const CLIPBOARD = 'data:image/png;base64,CLIPBOARD'
const DOWNLOAD = 'data:image/jpeg;base64,DOWNLOAD'

function makeDeps(overrides: Partial<ViewportCaptureDeps> = {}) {
  const offscreenCalls: OffscreenRequest[] = []
  const deps: ViewportCaptureDeps = {
    captureVisibleTab: vi.fn(async () => FRAME),
    ensureOffscreen: vi.fn(async () => {}),
    getDevicePixelRatio: vi.fn(async () => 2),
    sendToOffscreen: vi.fn(async (request: OffscreenRequest) => {
      offscreenCalls.push(request)
      return request.type === 'encodeSingleFrame'
        ? { ok: true as const, clipboardDataUrl: CLIPBOARD, downloadDataUrl: DOWNLOAD }
        : { ok: true as const }
    }),
    ...overrides,
  }
  return { deps, offscreenCalls }
}

const encode = { scale: 1, downloadFormat: 'jpeg' } as const

describe('runViewportCapture', () => {
  it('encodes the single captured frame and returns both images', async () => {
    const { deps, offscreenCalls } = makeDeps()

    await expect(runViewportCapture(deps, encode)).resolves.toEqual({
      clipboardDataUrl: CLIPBOARD,
      downloadDataUrl: DOWNLOAD,
    })

    expect(offscreenCalls).toEqual([
      {
        type: 'encodeSingleFrame',
        dataUrl: FRAME,
        scale: 1,
        downloadFormat: 'jpeg',
        devicePixelRatio: 2,
      },
    ])
    expect(deps.captureVisibleTab).toHaveBeenCalledTimes(1)
  })

  // The whole point of the viewport path: the page is never touched, so there
  // is nothing to measure, scroll, hide or restore -- and no content script to
  // inject in order to do any of it.
  it('never begins a stitched capture', async () => {
    const { deps, offscreenCalls } = makeDeps()
    await runViewportCapture(deps, encode)
    const types = offscreenCalls.map((request) => request.type)
    expect(types).not.toContain('beginCapture')
    expect(types).not.toContain('addFrame')
    expect(types).not.toContain('finishCapture')
  })

  it('creates the offscreen document before asking it to encode', async () => {
    const order: string[] = []
    const { deps } = makeDeps({
      ensureOffscreen: vi.fn(async () => {
        order.push('ensureOffscreen')
      }),
      sendToOffscreen: vi.fn(async () => {
        order.push('encode')
        return { ok: true as const, clipboardDataUrl: CLIPBOARD, downloadDataUrl: DOWNLOAD }
      }),
    })
    await runViewportCapture(deps, encode)
    expect(order).toEqual(['ensureOffscreen', 'encode'])
  })

  it('fails when the offscreen document reports an error', async () => {
    const { deps } = makeDeps({
      sendToOffscreen: vi.fn(async () => ({ ok: false as const, error: 'no canvas' })),
    })
    await expect(runViewportCapture(deps, encode)).rejects.toThrow('no canvas')
  })

  it('fails when the offscreen document reports success without an image', async () => {
    const { deps } = makeDeps({
      sendToOffscreen: vi.fn(async () => ({ ok: true as const })),
    })
    await expect(runViewportCapture(deps, encode)).rejects.toThrow(/no image/i)
  })
})

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
    isTabStillActive: vi.fn(async () => true),
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

  // The frame already exists and nothing about the page was altered, so
  // aborting here would throw away a perfectly good capture under a red badge.
  // dpr 1 means "no downscale", which is the documented safe reading.
  it('still delivers at dpr 1 when the tab cannot be asked for its ratio', async () => {
    const { deps, offscreenCalls } = makeDeps({
      getDevicePixelRatio: vi.fn(async () => {
        throw new Error('cannot access contents of the page')
      }),
    })

    await expect(runViewportCapture(deps, encode)).resolves.toEqual({
      clipboardDataUrl: CLIPBOARD,
      downloadDataUrl: DOWNLOAD,
    })
    expect(offscreenCalls[0]).toMatchObject({ devicePixelRatio: 1 })
  })

  // captureVisibleTab grabs whatever is on screen *now*. Between the gesture
  // and the capture the user can switch tabs, and Chrome would hand back the
  // new tab's pixels under the original tab's filename -- a wrong screenshot
  // under a green badge, which is exactly what the full path guards against.
  it('refuses to capture once the user has switched away', async () => {
    const { deps, offscreenCalls } = makeDeps({
      isTabStillActive: vi.fn(async () => false),
    })

    await expect(runViewportCapture(deps, encode)).rejects.toThrow(/no longer active/i)
    expect(deps.captureVisibleTab).not.toHaveBeenCalled()
    expect(offscreenCalls).toEqual([])
  })

  it('captures while the tab is still active', async () => {
    const { deps } = makeDeps()
    await runViewportCapture(deps, encode)
    expect(deps.isTabStillActive).toHaveBeenCalled()
    expect(deps.captureVisibleTab).toHaveBeenCalledTimes(1)
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

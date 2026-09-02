import { describe, expect, it, vi } from 'vitest'
import {
  runSelectionCapture,
  type SelectionCaptureDeps,
} from '../../src/background/selection-capture'
import type { ContentRequest, ContentResponse, CssRect, OffscreenRequest } from '../../src/shared/messages'

const FRAME = 'data:image/png;base64,FRAME'
const CLIPBOARD = 'data:image/png;base64,CLIPBOARD'
const DOWNLOAD = 'data:image/jpeg;base64,DOWNLOAD'
const RECT: CssRect = { x: 100, y: 40, width: 300, height: 200 }

function makeDeps(overrides: Partial<SelectionCaptureDeps> = {}) {
  const offscreenCalls: OffscreenRequest[] = []
  const contentCalls: ContentRequest[] = []
  const deps: SelectionCaptureDeps = {
    injectContentScript: vi.fn(async () => {}),
    sendToContent: vi.fn(async (request: ContentRequest): Promise<ContentResponse> => {
      contentCalls.push(request)
      return request.type === 'selectArea' ? { ok: true, rect: RECT } : { ok: true }
    }),
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
  return { deps, offscreenCalls, contentCalls }
}

/**
 * A `sendToContent` whose `selectArea` answer is whatever the test says: a
 * reply, or an `Error` to throw instead of replying at all — the difference
 * between "the overlay came down" and "nobody knows whether it did".
 */
function replyingWith(answer: ContentResponse | Error) {
  const contentCalls: ContentRequest[] = []
  const sendToContent = vi.fn(async (request: ContentRequest): Promise<ContentResponse> => {
    contentCalls.push(request)
    if (request.type !== 'selectArea') return { ok: true }
    if (answer instanceof Error) throw answer
    return answer
  })
  return { sendToContent, contentCalls }
}

const encode = { scale: 1, downloadFormat: 'jpeg' } as const

describe('runSelectionCapture', () => {
  it('passes the selected rect through to the encoder as the crop', async () => {
    const { deps, offscreenCalls } = makeDeps()

    await expect(runSelectionCapture(deps, encode)).resolves.toEqual({
      status: 'captured',
      clipboardDataUrl: CLIPBOARD,
      downloadDataUrl: DOWNLOAD,
    })

    expect(offscreenCalls).toEqual([
      {
        type: 'encodeSingleFrame',
        dataUrl: FRAME,
        crop: RECT,
        scale: 1,
        downloadFormat: 'jpeg',
        devicePixelRatio: 2,
      },
    ])
    expect(deps.captureVisibleTab).toHaveBeenCalledTimes(1)
  })

  it('injects the content script before asking for a selection', async () => {
    const order: string[] = []
    const { deps } = makeDeps({
      injectContentScript: vi.fn(async () => {
        order.push('inject')
      }),
      sendToContent: vi.fn(async (request: ContentRequest): Promise<ContentResponse> => {
        order.push(request.type)
        return { ok: true, rect: RECT }
      }),
    })
    await runSelectionCapture(deps, encode)
    expect(order).toEqual(['inject', 'selectArea'])
  })

  // The whole point of "cancel is not failure": the user said no, so nothing
  // is captured, nothing is encoded, and nothing is delivered -- and the
  // caller is told so rather than being handed an error to badge red.
  it('captures and encodes nothing when the user cancels', async () => {
    const { sendToContent, contentCalls } = replyingWith({ ok: true, rect: null })
    const { deps, offscreenCalls } = makeDeps({ sendToContent })

    await expect(runSelectionCapture(deps, encode)).resolves.toEqual({ status: 'cancelled' })

    expect(deps.captureVisibleTab).not.toHaveBeenCalled()
    expect(deps.ensureOffscreen).not.toHaveBeenCalled()
    expect(offscreenCalls).toEqual([])
    expect(contentCalls.map((request) => request.type)).toEqual(['selectArea'])
  })

  // The content script removed the overlay itself before replying, so there is
  // nothing left to put back and a `restore` here would be noise on the wire.
  it('sends no restore once the selection has been answered', async () => {
    const { sendToContent, contentCalls } = replyingWith({ ok: true, rect: null })
    const { deps } = makeDeps({ sendToContent })
    await runSelectionCapture(deps, encode)
    expect(contentCalls.map((request) => request.type)).not.toContain('restore')
  })

  // The other half of the same rule: no reply means the overlay may still be
  // up, and the only thing that can take it down is a message.
  it('restores the page when the message channel fails', async () => {
    const { sendToContent, contentCalls } = replyingWith(
      new Error('Could not establish connection'),
    )
    const { deps } = makeDeps({ sendToContent })

    await expect(runSelectionCapture(deps, encode)).rejects.toThrow(/could not establish/i)
    expect(contentCalls.map((request) => request.type)).toEqual(['selectArea', 'restore'])
    expect(deps.captureVisibleTab).not.toHaveBeenCalled()
  })

  it('restores the page when the content script reports an error', async () => {
    const { sendToContent, contentCalls } = replyingWith({ ok: false, error: 'overlay blew up' })
    const { deps } = makeDeps({ sendToContent })

    await expect(runSelectionCapture(deps, encode)).rejects.toThrow('overlay blew up')
    expect(contentCalls.map((request) => request.type)).toEqual(['selectArea', 'restore'])
  })

  it('restores the page when the injection itself fails', async () => {
    const { sendToContent, contentCalls } = replyingWith({ ok: true, rect: RECT })
    const { deps } = makeDeps({
      sendToContent,
      injectContentScript: vi.fn(async () => {
        throw new Error('cannot access contents of the page')
      }),
    })

    await expect(runSelectionCapture(deps, encode)).rejects.toThrow(/cannot access/i)
    expect(contentCalls.map((request) => request.type)).toEqual(['restore'])
  })

  // A failed restore must not turn into the error the caller sees: the real
  // failure is the one above it.
  it('reports the original failure even when the restore also fails', async () => {
    const sendToContent = vi.fn(async (request: ContentRequest): Promise<ContentResponse> => {
      throw new Error(request.type === 'restore' ? 'tab is gone' : 'Could not establish connection')
    })
    const { deps } = makeDeps({ sendToContent })
    await expect(runSelectionCapture(deps, encode)).rejects.toThrow(/could not establish/i)
  })

  // Same race as the viewport path: captureVisibleTab returns whatever is on
  // screen *now*, and a selection made on one tab must never be cropped out of
  // another tab's pixels.
  it('refuses to capture once the user has switched away', async () => {
    const { deps, offscreenCalls } = makeDeps({ isTabStillActive: vi.fn(async () => false) })

    await expect(runSelectionCapture(deps, encode)).rejects.toThrow(/no longer active/i)
    expect(deps.captureVisibleTab).not.toHaveBeenCalled()
    expect(offscreenCalls).toEqual([])
  })

  it('never begins a stitched capture', async () => {
    const { deps, offscreenCalls } = makeDeps()
    await runSelectionCapture(deps, encode)
    const types = offscreenCalls.map((request) => request.type)
    expect(types).not.toContain('beginCapture')
    expect(types).not.toContain('addFrame')
    expect(types).not.toContain('finishCapture')
  })

  // Selection mode measures nothing, scrolls nothing and hides nothing: the
  // only thing it ever asks the page for is the rectangle.
  it('sends no measure, hideFixed or scrollTo', async () => {
    const { deps, contentCalls } = makeDeps()
    await runSelectionCapture(deps, encode)
    expect(contentCalls.map((request) => request.type)).toEqual(['selectArea'])
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
    await runSelectionCapture(deps, encode)
    expect(order).toEqual(['ensureOffscreen', 'encode'])
  })

  it('still delivers at dpr 1 when the tab cannot be asked for its ratio', async () => {
    const { deps, offscreenCalls } = makeDeps({
      getDevicePixelRatio: vi.fn(async () => {
        throw new Error('cannot access contents of the page')
      }),
    })

    await expect(runSelectionCapture(deps, encode)).resolves.toMatchObject({ status: 'captured' })
    expect(offscreenCalls[0]).toMatchObject({ devicePixelRatio: 1, crop: RECT })
  })

  it('fails when the offscreen document reports an error', async () => {
    const { deps } = makeDeps({
      sendToOffscreen: vi.fn(async () => ({ ok: false as const, error: 'crop is empty' })),
    })
    await expect(runSelectionCapture(deps, encode)).rejects.toThrow('crop is empty')
  })

  it('fails when the offscreen document reports success without an image', async () => {
    const { deps } = makeDeps({
      sendToOffscreen: vi.fn(async () => ({ ok: true as const })),
    })
    await expect(runSelectionCapture(deps, encode)).rejects.toThrow(/no image/i)
  })

  // A reply with no `rect` at all is not a selection, and the one thing that
  // must never happen is cropping to a guess: treat it as the cancel it is.
  it('treats a reply with no rect as a cancel', async () => {
    const { sendToContent } = replyingWith({ ok: true })
    const { deps } = makeDeps({ sendToContent })
    await expect(runSelectionCapture(deps, encode)).resolves.toEqual({ status: 'cancelled' })
    expect(deps.captureVisibleTab).not.toHaveBeenCalled()
  })
})

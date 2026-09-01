import { describe, expect, it, vi } from 'vitest'
import { runCapture } from '../../src/background/capture-loop'
import type { CaptureDeps } from '../../src/background/capture-loop'
import type { ContentRequest, OffscreenRequest } from '../../src/shared/messages'
import type { PageMeasurements } from '../../src/core/types'

const measurements: PageMeasurements = {
  scrollWidth: 1000,
  scrollHeight: 2000,
  viewportWidth: 1000,
  viewportHeight: 800,
  devicePixelRatio: 1,
  scrollX: 0,
  scrollY: 0,
}

function makeDeps(overrides: Partial<CaptureDeps> = {}) {
  const contentCalls: ContentRequest[] = []
  const offscreenCalls: string[] = []
  // A single ordered log across ALL three channels. Per-channel logs cannot
  // express "the header was still visible when frame 0 was taken", because
  // that claim is about where `hideFixed` sits relative to a *capture* — and
  // a content-only log makes any position after the first `scrollTo` look
  // correct, including hiding before a single frame exists.
  const events: string[] = []
  const deps: CaptureDeps = {
    sendToContent: vi.fn(async (_tabId: number, request: ContentRequest) => {
      contentCalls.push(request)
      events.push(`content:${request.type}`)
      return request.type === 'measure'
        ? { ok: true as const, measurements }
        : { ok: true as const }
    }),
    sendToOffscreen: vi.fn(async (request: OffscreenRequest) => {
      offscreenCalls.push(request.type)
      events.push(`offscreen:${request.type}`)
      return { ok: true as const, downloadPending: false }
    }),
    captureVisibleTab: vi.fn(async () => {
      events.push('capture')
      return 'data:image/png;base64,AAAA'
    }),
    ensureOffscreen: vi.fn(async () => {}),
    isTabStillActive: vi.fn(async () => true),
    prefs: { toClipboard: true, toDownload: true },
    filename: 'full-page-shot/example.com-2026-09-01T00-00-00.png',
    delay: vi.fn(async () => {}),
    ...overrides,
  }
  return { deps, contentCalls, offscreenCalls, events }
}

describe('runCapture', () => {
  it('captures one frame per planned step', async () => {
    const { deps } = makeDeps()
    await runCapture(1, deps)
    expect(deps.captureVisibleTab).toHaveBeenCalledTimes(3)
  })

  it('shows fixed elements on the first frame and hides them afterwards', async () => {
    const { deps, events } = makeDeps()
    await runCapture(1, deps)

    // Hiding must land strictly between the first and second captures.
    // Earlier strips the header from the whole screenshot; later (or never)
    // repeats it down the page.
    const hides = events.filter((event) => event === 'content:hideFixed')
    expect(hides).toHaveLength(1)

    const captures = events.reduce<number[]>(
      (acc, event, i) => (event === 'capture' ? [...acc, i] : acc),
      [],
    )
    const hide = events.indexOf('content:hideFixed')
    expect(hide).toBeGreaterThan(captures[0] ?? -1)
    expect(hide).toBeLessThan(captures[1] ?? -1)
  })

  it('streams each frame instead of batching them', async () => {
    const { deps, offscreenCalls } = makeDeps()
    await runCapture(1, deps)
    expect(offscreenCalls.filter((t) => t === 'addFrame')).toHaveLength(3)
    expect(offscreenCalls[0]).toBe('beginCapture')
    expect(offscreenCalls.at(-1)).toBe('finishCapture')
  })

  it('restores the page even when a capture call throws', async () => {
    const { deps, contentCalls } = makeDeps({
      captureVisibleTab: vi.fn(async () => {
        throw new Error('rate limited')
      }),
    })
    await expect(runCapture(1, deps)).rejects.toThrow('rate limited')
    expect(contentCalls.at(-1)?.type).toBe('restore')
  })

  it('aborts the offscreen canvas when the capture fails', async () => {
    const { deps, offscreenCalls } = makeDeps({
      captureVisibleTab: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    await expect(runCapture(1, deps)).rejects.toThrow('boom')
    expect(offscreenCalls).toContain('abortCapture')
    expect(offscreenCalls).not.toContain('finishCapture')
  })

  it('throttles between captures', async () => {
    const { deps } = makeDeps()
    await runCapture(1, deps)
    expect(deps.delay).toHaveBeenCalled()
  })

  it('aborts when the user switches away from the tab mid-capture', async () => {
    let calls = 0
    const { deps, contentCalls, offscreenCalls } = makeDeps({
      isTabStillActive: vi.fn(async () => {
        calls += 1
        return calls < 2
      }),
    })

    await expect(runCapture(1, deps)).rejects.toThrow(/no longer active/i)
    expect(deps.captureVisibleTab).toHaveBeenCalledTimes(1)
    expect(offscreenCalls).toContain('abortCapture')
    expect(contentCalls.at(-1)?.type).toBe('restore')
  })

  // The offscreen document owns the blob URL the download is reading from, so
  // closing it while the download is still writing truncates the file. That
  // decision belongs to the caller, which means `runCapture` has to hand the
  // flag back rather than swallow it.
  it('reports downloadPending: false so the caller may close the offscreen document', async () => {
    const { deps } = makeDeps()
    await expect(runCapture(1, deps)).resolves.toEqual({ downloadPending: false })
  })

  it('propagates downloadPending: true from finishCapture', async () => {
    const { deps } = makeDeps({
      sendToOffscreen: vi.fn(async (request: OffscreenRequest) => ({
        ok: true as const,
        downloadPending: request.type === 'finishCapture',
      })),
    })
    await expect(runCapture(1, deps)).resolves.toEqual({ downloadPending: true })
  })
})

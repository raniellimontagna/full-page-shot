import { describe, expect, it, vi } from 'vitest'
import {
  CAPTURE_QUOTA_MAX_ATTEMPTS,
  quotaBackoffMs,
  runCapture,
} from '../../src/background/capture-loop'
import type { CaptureDeps } from '../../src/background/capture-loop'
import type { ContentRequest, OffscreenRequest } from '../../src/shared/messages'
import type { PageMeasurements } from '../../src/core/types'

/** Stands in for the stitched PNG the offscreen document hands back. */
const STITCHED = 'data:image/png;base64,STITCHED'

const measurements: PageMeasurements = {
  scrollWidth: 1000,
  scrollHeight: 2000,
  viewportWidth: 1000,
  viewportHeight: 800,
  devicePixelRatio: 1,
  scrollX: 0,
  scrollY: 0,
}

function makeDeps(overrides: Partial<CaptureDeps> = {}, page: PageMeasurements = measurements) {
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
        ? { ok: true as const, measurements: page }
        : { ok: true as const }
    }),
    sendToOffscreen: vi.fn(async (request: OffscreenRequest) => {
      offscreenCalls.push(request.type)
      events.push(`offscreen:${request.type}`)
      return request.type === 'finishCapture'
        ? { ok: true as const, dataUrl: STITCHED }
        : { ok: true as const }
    }),
    captureVisibleTab: vi.fn(async () => {
      events.push('capture')
      return 'data:image/png;base64,AAAA'
    }),
    ensureOffscreen: vi.fn(async () => {}),
    isTabStillActive: vi.fn(async () => true),
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

  // `runCapture` produces the image and stops. It does not deliver it, does not
  // know the user's preferences and does not touch the offscreen document's
  // lifetime -- so the image has to come back out for the caller to use.
  it('returns the stitched image from finishCapture', async () => {
    const { deps } = makeDeps()
    await expect(runCapture(1, deps)).resolves.toEqual({
      dataUrl: STITCHED,
      truncated: false,
      canvasWidth: 1000,
      canvasHeight: 2000,
    })
  })

  // `truncated` was set by the planner and read by nobody, so a page clamped to
  // Chrome's canvas ceilings was delivered cropped under a plain ✓. The plan is
  // built and thrown away inside runCapture, so this is the only place that can
  // carry the fact out to the caller that owns the badge.
  it('reports a plan the canvas limits truncated', async () => {
    const { deps } = makeDeps({}, { ...measurements, scrollHeight: 400_000 })
    const outcome = await runCapture(1, deps)
    expect(outcome.truncated).toBe(true)
    // Clamped to Chrome's 65,535-device-px maximum canvas dimension.
    expect(outcome.canvasHeight).toBe(65_535)
  })

  describe('the capture quota', () => {
    /** What Chrome actually rejects with when the per-second budget is spent. */
    const quotaError = new Error(
      'MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota exceeded.',
    )

    /**
     * A one-frame page, so `captureVisibleTab` call counts read as attempts on
     * a single frame rather than attempts times frames.
     */
    const oneFrame: PageMeasurements = { ...measurements, scrollHeight: 800 }

    it('retries the quota rejection and delivers the capture', async () => {
      let calls = 0
      const { deps, contentCalls } = makeDeps(
        {
          captureVisibleTab: vi.fn(async () => {
            calls += 1
            if (calls <= 2) throw quotaError
            return 'data:image/png;base64,AAAA'
          }),
        },
        oneFrame,
      )

      // Two rejections then success, inside one frame's attempt budget: the
      // capture is delivered rather than aborted, which is the whole point.
      await expect(runCapture(1, deps)).resolves.toMatchObject({ dataUrl: STITCHED })
      expect(calls).toBe(3)
      expect(contentCalls.at(-1)?.type).toBe('restore')
    })

    it('backs off between attempts', async () => {
      let calls = 0
      const { deps } = makeDeps(
        {
          captureVisibleTab: vi.fn(async () => {
            calls += 1
            if (calls <= 2) throw quotaError
            return 'data:image/png;base64,AAAA'
          }),
        },
        oneFrame,
      )
      await runCapture(1, deps)

      const waits = (deps.delay as unknown as { mock: { calls: number[][] } }).mock.calls.map(
        (args) => args[0],
      )
      expect(waits.slice(0, 2)).toEqual([quotaBackoffMs(1), quotaBackoffMs(2)])
    })

    it('gives up after the attempt budget and restores the page', async () => {
      const { deps, contentCalls, offscreenCalls } = makeDeps(
        {
          captureVisibleTab: vi.fn(async () => {
            throw quotaError
          }),
        },
        oneFrame,
      )

      await expect(runCapture(1, deps)).rejects.toThrow(/MAX_CAPTURE_VISIBLE_TAB/)
      expect(deps.captureVisibleTab).toHaveBeenCalledTimes(CAPTURE_QUOTA_MAX_ATTEMPTS)
      expect(offscreenCalls).toContain('abortCapture')
      expect(contentCalls.at(-1)?.type).toBe('restore')
    })

    it('does not retry an error that is not the quota', async () => {
      const { deps, contentCalls, offscreenCalls } = makeDeps(
        {
          captureVisibleTab: vi.fn(async () => {
            throw new Error('No tab with id 7.')
          }),
        },
        oneFrame,
      )

      await expect(runCapture(1, deps)).rejects.toThrow('No tab with id 7.')
      expect(deps.captureVisibleTab).toHaveBeenCalledTimes(1)
      expect(offscreenCalls).toContain('abortCapture')
      expect(contentCalls.at(-1)?.type).toBe('restore')
    })

    // A retry sleeps for up to 2.2 s. Checking the tab once per frame would let
    // the user switch tabs inside that window and get someone else's page
    // spliced into their screenshot -- the exact bug the check exists to stop.
    it('re-checks the active tab before every attempt', async () => {
      let captures = 0
      let checks = 0
      const { deps } = makeDeps(
        {
          captureVisibleTab: vi.fn(async () => {
            captures += 1
            throw quotaError
          }),
          isTabStillActive: vi.fn(async () => {
            checks += 1
            // Still active for the first attempt, gone by the retry.
            return checks < 2
          }),
        },
        oneFrame,
      )

      await expect(runCapture(1, deps)).rejects.toThrow(/no longer active/i)
      expect(captures).toBe(1)
    })
  })

  it('asks the offscreen document to finish without any sink options', async () => {
    // Delivery moved out of the offscreen document entirely, so nothing about
    // the clipboard, the download or the filename belongs on this message any
    // more. A stray option here would mean a second implementation of the
    // sinks had grown back in the one context that cannot run them.
    const sent: OffscreenRequest[] = []
    const { deps } = makeDeps({
      sendToOffscreen: vi.fn(async (request: OffscreenRequest) => {
        sent.push(request)
        return request.type === 'finishCapture'
          ? { ok: true as const, dataUrl: STITCHED }
          : { ok: true as const }
      }),
    })
    await runCapture(1, deps)
    expect(sent.at(-1)).toEqual({ type: 'finishCapture' })
  })

  // `ok: true` with no image is a broken offscreen document, not a success.
  // Silently returning `undefined` here would hand the sinks an empty data URL
  // and deliver a corrupt file under a ✓ badge.
  it('fails when finishCapture reports success without an image', async () => {
    const { deps, contentCalls } = makeDeps({
      sendToOffscreen: vi.fn(async (request: OffscreenRequest) =>
        request.type === 'finishCapture' ? { ok: true as const } : { ok: true as const },
      ),
    })
    await expect(runCapture(1, deps)).rejects.toThrow(/returned no image/)
    expect(contentCalls.at(-1)?.type).toBe('restore')
  })
})

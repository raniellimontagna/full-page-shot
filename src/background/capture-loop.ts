import { planCapture } from '../core/page-metrics'
import { computeFramePlacements } from '../core/stitch-plan'
import type {
  ContentRequest,
  ContentResponse,
  OffscreenRequest,
  OffscreenResponse,
} from '../shared/messages'

/** captureVisibleTab is quota-limited; this spacing keeps the loop under it. */
export const CAPTURE_INTERVAL_MS = 550

/**
 * How many times a single frame is attempted before the capture gives up.
 *
 * The fixed `CAPTURE_INTERVAL_MS` spacing keeps the loop under
 * `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` on paper, but it is open-loop: it
 * assumes this extension is the only caller and that the service worker is
 * scheduled promptly. Neither is guaranteed -- another extension capturing the
 * same window, or a throttled worker firing two calls back to back after a
 * stall, spends quota this loop never counted -- and a single rejection used
 * to abort the whole capture after the user had already waited through most
 * of the page.
 */
export const CAPTURE_QUOTA_MAX_ATTEMPTS = 3

/**
 * Backoff before retry `n` (1-based): 550, 1100, 2200 ms.
 *
 * The quota is a per-second budget, so the first retry only has to outlast the
 * current second; doubling from the throttle interval gives the budget room to
 * refill when the contention is heavier than that. With
 * `CAPTURE_QUOTA_MAX_ATTEMPTS` at 3 a frame waits at most 550 + 1100 ms.
 */
export function quotaBackoffMs(retry: number): number {
  return CAPTURE_INTERVAL_MS * 2 ** (retry - 1)
}

/**
 * Only the quota rejection is retried.
 *
 * Chrome reports it as an error mentioning `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`.
 * Everything else -- the tab was closed, the page is a restricted URL, the
 * window went away -- is permanent for this capture, and retrying it would
 * only hold the page hostage (scrolled, header hidden) for seconds longer
 * before failing anyway.
 */
export function isQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|per second/i.test(message)
}

/**
 * One frame, with a bounded retry on the capture quota.
 *
 * The active-tab check runs before *every* attempt, not once per frame: a
 * retry sleeps for up to 2.2 s and the user can switch tabs inside that
 * window, and capturing after they did would splice someone else's page into
 * the screenshot -- the exact bug the check exists to prevent.
 */
async function captureFrame(deps: CaptureDeps): Promise<string> {
  let lastError: unknown
  for (let attempt = 1; attempt <= CAPTURE_QUOTA_MAX_ATTEMPTS; attempt += 1) {
    // captureVisibleTab grabs whatever is on screen. If the user switched
    // tabs, the next frame would be someone else's page -- stop instead.
    if (!(await deps.isTabStillActive())) {
      throw new Error('tab is no longer active')
    }
    try {
      return await deps.captureVisibleTab()
    } catch (error) {
      if (!isQuotaError(error)) throw error
      lastError = error
      if (attempt < CAPTURE_QUOTA_MAX_ATTEMPTS) await deps.delay(quotaBackoffMs(attempt))
    }
  }
  throw lastError
}

export interface CaptureDeps {
  sendToContent: (tabId: number, request: ContentRequest) => Promise<ContentResponse>
  sendToOffscreen: (request: OffscreenRequest) => Promise<OffscreenResponse>
  captureVisibleTab: () => Promise<string>
  ensureOffscreen: () => Promise<void>
  /** False once the user has switched tabs or windows — the capture must stop. */
  isTabStillActive: () => Promise<boolean>
  delay: (ms: number) => Promise<void>
}

export interface CaptureOutcome {
  /**
   * The stitched PNG, as a data URL.
   *
   * `runCapture` produces the image and stops there: it neither delivers it
   * nor closes the offscreen document. Delivery needs the user's preferences,
   * a filename and a badge, and the document's lifetime belongs to whoever
   * created it — none of which is this function's business. Returning the
   * image is also what lets the caller close the offscreen document
   * immediately, since a data URL keeps working after the document that made
   * it is gone.
   */
  dataUrl: string
  /**
   * Whether `planCapture` had to clamp the page to Chrome's canvas ceilings,
   * i.e. the delivered image is a correct capture of the *top* of the page and
   * not of all of it.
   *
   * Carried out of here because it is the only place that knows: the plan is
   * built and consumed inside this function, and the flag died with it --
   * `page-metrics` set `truncated`, nothing ever read it, and a silently
   * cropped capture was delivered under a plain ✓. The caller is what owns the
   * badge, so the caller is what has to be told.
   */
  truncated: boolean
  /** The clamped canvas size, in device pixels, for the truncation warning. */
  canvasWidth: number
  canvasHeight: number
}

function unwrap(response: ContentResponse | OffscreenResponse): void {
  if (!response.ok) throw new Error(response.error)
}

export async function runCapture(tabId: number, deps: CaptureDeps): Promise<CaptureOutcome> {
  let began = false

  // Everything from `measure` onward sits inside the try. `measure` latches
  // the user's original scroll position in the content script, so from that
  // call on the page is mid-capture and something must send `restore` -- and
  // planCapture, computeFramePlacements and ensureOffscreen can all throw
  // (a canvas-limit violation, a cross-module contract breach, a failed
  // offscreen creation). Outside the try those escaped with the page left
  // latched and no restore ever sent.
  try {
    const measured = await deps.sendToContent(tabId, { type: 'measure' })
    if (!measured.ok) throw new Error(measured.error)
    const measurements = measured.measurements
    if (!measurements) throw new Error('page measurement failed')

    const plan = planCapture(measurements)
    const placements = computeFramePlacements(plan, measurements)

    await deps.ensureOffscreen()

    unwrap(
      await deps.sendToOffscreen({
        type: 'beginCapture',
        width: plan.canvasWidth,
        height: plan.canvasHeight,
      }),
    )
    began = true

    for (const [i, step] of plan.steps.entries()) {
      const placement = placements[i]
      if (!placement) throw new Error(`missing placement for step ${i}`)

      unwrap(await deps.sendToContent(tabId, { type: 'scrollTo', y: step.scrollY }))

      // Fixed headers belong in the first frame and nowhere else. Frame 0 is
      // therefore captured with them still visible; they are hidden here,
      // once, on the way into frame 1. Hiding before frame 0 would strip the
      // header from the whole screenshot; never hiding would repeat it in
      // every frame down the page.
      if (i === 1) unwrap(await deps.sendToContent(tabId, { type: 'hideFixed' }))

      if (i > 0) await deps.delay(CAPTURE_INTERVAL_MS)

      const dataUrl = await captureFrame(deps)

      // One frame at a time, straight through to the offscreen canvas: the
      // service worker never holds an array of data URLs, because MV3 can
      // evict it mid-capture and the memory spike alone can be hundreds of MB.
      unwrap(
        await deps.sendToOffscreen({
          type: 'addFrame',
          dataUrl,
          destY: placement.destY,
          sourceHeight: placement.sourceHeight,
        }),
      )
    }

    // TODO(Task 3): pass the user's `scale`/`downloadFormat` and the captured
    // tab's real `devicePixelRatio` through from the caller. Until the service
    // worker learns to read those preferences, this asks for exactly the 1.0.0
    // behaviour -- the canvas as captured, PNG -- so nothing changes yet.
    const finished = await deps.sendToOffscreen({
      type: 'finishCapture',
      scale: 2,
      downloadFormat: 'png',
      devicePixelRatio: 1,
    })
    if (!finished.ok) throw new Error(finished.error)
    if (!finished.clipboardDataUrl) throw new Error('the offscreen document returned no image')
    began = false

    return {
      dataUrl: finished.clipboardDataUrl,
      truncated: plan.truncated,
      canvasWidth: plan.canvasWidth,
      canvasHeight: plan.canvasHeight,
    }
  } catch (error) {
    if (began) await deps.sendToOffscreen({ type: 'abortCapture' }).catch(() => {})
    throw error
  } finally {
    // The page must never be left scrolled or with a hidden header. This runs
    // on every path, and `restore` is idempotent on the content-script side,
    // so a double restore is harmless — an un-restored page is not.
    await deps.sendToContent(tabId, { type: 'restore' }).catch(() => {})
  }
}

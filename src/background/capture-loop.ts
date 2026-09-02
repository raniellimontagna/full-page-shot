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

      // captureVisibleTab grabs whatever is on screen. If the user switched
      // tabs, the next frame would be someone else's page — stop instead.
      if (!(await deps.isTabStillActive())) {
        throw new Error('tab is no longer active')
      }

      const dataUrl = await deps.captureVisibleTab()

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

    const finished = await deps.sendToOffscreen({ type: 'finishCapture' })
    if (!finished.ok) throw new Error(finished.error)
    if (!finished.dataUrl) throw new Error('the offscreen document returned no image')
    began = false

    return { dataUrl: finished.dataUrl }
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

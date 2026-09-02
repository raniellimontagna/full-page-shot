import type { OffscreenRequest, OffscreenResponse } from '../shared/messages'
import type { EncodeOptions } from './capture-loop'

/**
 * Everything the viewport path needs, injected — the same seam as
 * `CaptureDeps`, and for the same reason: it is what makes this module
 * testable without a browser.
 *
 * Note what is *absent*, because the absence is the design. There is no
 * `sendToContent`, no `isTabStillActive` and no `delay`: this path never
 * injects the content script, never measures the page, never scrolls it,
 * never hides fixed elements and never waits out the capture quota, because
 * it takes exactly one frame of what is already on screen.
 */
export interface ViewportCaptureDeps {
  captureVisibleTab: () => Promise<string>
  sendToOffscreen: (request: OffscreenRequest) => Promise<OffscreenResponse>
  ensureOffscreen: () => Promise<void>
  /**
   * The captured tab's `window.devicePixelRatio`.
   *
   * A frame from `captureVisibleTab` is in device pixels, so 1× output has to
   * divide by this — the same arithmetic the full path gets for free from the
   * `measure` reply. Asynchronous because reading it means asking the tab.
   */
  getDevicePixelRatio: () => Promise<number>
}

export interface ViewportCaptureOutcome {
  clipboardDataUrl: string
  downloadDataUrl: string
}

/**
 * Captures just what the user can see, and encodes it.
 *
 * There is no `restore` here, and no `finally` that sends one: nothing about
 * the page is ever altered. The full-page path has to latch the scroll
 * position, scroll the document and hide fixed elements, which is why it owes
 * the page a restore on every exit path including a crash. This path reads one
 * frame of the viewport exactly as it stands — no scroll, no style change, no
 * injected script at all — so there is nothing to put back and a failure here
 * leaves the page byte-for-byte as it was found.
 *
 * It cannot be truncated either: one viewport is always far inside Chrome's
 * canvas ceilings, so no plan is made and no clamping can happen. The caller's
 * badge logic still runs unchanged; it is simply never handed `truncated`.
 */
export async function runViewportCapture(
  deps: ViewportCaptureDeps,
  encode: EncodeOptions,
): Promise<ViewportCaptureOutcome> {
  const [dataUrl, devicePixelRatio] = await Promise.all([
    deps.captureVisibleTab(),
    deps.getDevicePixelRatio(),
  ])

  await deps.ensureOffscreen()

  const encoded = await deps.sendToOffscreen({
    type: 'encodeSingleFrame',
    dataUrl,
    scale: encode.scale,
    downloadFormat: encode.downloadFormat,
    devicePixelRatio,
  })
  if (!encoded.ok) throw new Error(encoded.error)
  if (!encoded.clipboardDataUrl || !encoded.downloadDataUrl) {
    throw new Error('the offscreen document returned no image')
  }

  return {
    clipboardDataUrl: encoded.clipboardDataUrl,
    downloadDataUrl: encoded.downloadDataUrl,
  }
}

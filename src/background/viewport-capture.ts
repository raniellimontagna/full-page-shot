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
  /**
   * False once the user has switched tabs or windows.
   *
   * `captureVisibleTab` grabs whatever is on screen at the moment it runs, not
   * whatever was on screen when the user asked. Without this the gesture and
   * the capture can straddle a tab switch and Chrome hands back the *new*
   * tab's pixels -- delivered under the original tab's filename, with a green
   * badge. The full path has always guarded this; one frame is a smaller
   * window for the race, not an absent one.
   */
  isTabStillActive: () => Promise<boolean>
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
 * injected content script — so there is nothing to put back and a failure here
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
  if (!(await deps.isTabStillActive())) {
    throw new Error('tab is no longer active')
  }

  const [dataUrl, devicePixelRatio] = await Promise.all([
    deps.captureVisibleTab(),
    // Never fatal. A rejected ratio read (the tab navigated somewhere
    // restricted, closed, or crashed between the gesture and the injection)
    // must not throw away a frame that already exists on a page nothing
    // altered -- and 1 means "no downscale", which is the safe reading.
    deps.getDevicePixelRatio().catch((error: unknown) => {
      console.warn(
        '[full-page-shot] could not read the tab\'s devicePixelRatio, ' +
          `assuming 1 (no downscale): ${error instanceof Error ? error.message : String(error)}`,
      )
      return 1
    }),
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

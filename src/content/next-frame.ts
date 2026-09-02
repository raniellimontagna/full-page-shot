/**
 * How long to wait for an animation frame that may never arrive.
 *
 * Generous next to a 60Hz frame (16ms) so it never pre-empts a healthy paint,
 * short enough that a stalled capture still answers well inside the message
 * timeouts above it.
 */
export const FRAME_TIMEOUT_MS = 200

/**
 * Resolves once the next animation frame has been serviced -- or after
 * `timeoutMs`, if it never is.
 *
 * The timeout is not belt-and-braces. Chrome stops servicing
 * `requestAnimationFrame` entirely in a background tab, so a page hidden at
 * the wrong moment (the user switches tabs between `pointerup` and the paint,
 * or between two capture frames) leaves a bare `await nextFrame` pending
 * forever. That is worse than it sounds in a content script: the awaiting code
 * sits in a `finally`, so `handle` never replies, `sendResponse` is never
 * called, and the service worker waits on a message that will not come. The
 * restore watchdog cannot help -- it restores the *page*, it cannot settle a
 * promise.
 *
 * Shared by the scroll driver and the selection overlay deliberately: both
 * need "the browser has had a chance to paint" with the same failure mode, and
 * two copies would eventually drift.
 */
export function nextFrame(win: Window, timeoutMs: number = FRAME_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    let timer: number | undefined

    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) win.clearTimeout(timer)
      resolve()
    }

    win.requestAnimationFrame(() => finish())
    // A frame that fired synchronously has already finished us; asking for a
    // timer here would mean asking the window to clear one it never handed out.
    if (settled) return
    timer = win.setTimeout(finish, timeoutMs)
  })
}

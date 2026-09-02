/**
 * Runs one capture at a time, browser-wide.
 *
 * Two overlapping captures cannot both be right. They share a single offscreen
 * document holding a single module-global stitcher, so the second
 * `beginCapture` replaces the first capture's canvas: frames from both pages
 * land on the same bitmap, the first capture's `finishCapture` reads back the
 * second's canvas, and the user gets a garbled PNG under a green badge. Two
 * ordinary gestures reach that state -- a double-click on the toolbar icon, or
 * a capture started in each of two windows, where the per-tab
 * `isTabStillActive` guard never trips because both tabs really are active in
 * their own window.
 *
 * The guard is a single flag rather than a `Set<tabId>` deliberately: the
 * contended resource is *global*, not per tab. A per-tab set would still let
 * two different tabs clobber each other's canvas, which is precisely the
 * cross-window case above -- it would guard only the double-click. Serialising
 * globally costs a rejected second capture (with the failure badge, so the
 * user knows to retry) and buys the invariant that a delivered PNG is always
 * the page it claims to be.
 *
 * `onBusy` runs *instead of* the body, never alongside it, so a rejected
 * capture never injects, scrolls or otherwise touches the page.
 */
export function createSingleFlight(): (
  body: () => Promise<void>,
  onBusy: () => Promise<void>,
) => Promise<void> {
  let inFlight = false
  return async (body, onBusy) => {
    if (inFlight) {
      await onBusy()
      return
    }
    inFlight = true
    try {
      await body()
    } finally {
      // In `finally`: a body that throws must still release the lock, or the
      // first failed capture wedges the extension until the service worker is
      // torn down and the user is left with a button that does nothing.
      inFlight = false
    }
  }
}

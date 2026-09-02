import type { ContentRequest, ContentResponse } from '../shared/messages'
import { copyDataUrlToClipboard } from './clipboard'
import { hideFixedElements, restoreFixedElements } from './fixed-elements'
import { measurePage, scrollToStep } from './scroll-driver'
import { removeSelectionOverlay, selectArea } from './selection-overlay'

/**
 * How long the page waits for the next capture command before restoring
 * itself unprompted.
 *
 * The orchestrator restores the page in a `finally`, but an MV3 service
 * worker can be evicted mid-capture, and an evicted worker runs no `finally`
 * — leaving the user's page scrolled with its header hidden, with nothing
 * left alive to put it back. The spec rule that a failed capture never alters
 * the page is absolute, so the guarantee has to live page-side, where it
 * cannot be killed.
 *
 * Sized well above the orchestrator's `CAPTURE_INTERVAL_MS` (550ms) plus the
 * scroll settle, so a healthy capture re-arms this long before it fires.
 */
export const RESTORE_WATCHDOG_MS = 10_000

let originalScrollY: number | null = null
let watchdog: ReturnType<typeof setTimeout> | null = null

function restorePage(): void {
  // The selection overlay is page state exactly like a hidden header is: if
  // the service worker dies while it is up, nothing else is left alive to take
  // it down and the user is stranded on a dimmed page that eats every click.
  // Putting it here means the watchdog covers it for free.
  removeSelectionOverlay(document)
  restoreFixedElements(document)
  if (originalScrollY !== null) {
    window.scrollTo({ top: originalScrollY, left: 0, behavior: 'instant' as ScrollBehavior })
    originalScrollY = null
  }
}

function clearWatchdog(): void {
  if (watchdog !== null) {
    clearTimeout(watchdog)
    watchdog = null
  }
}

/**
 * Re-armed by every command, so the timer only ever measures *silence*.
 * Arming once at the start of a capture instead would fire mid-capture on a
 * slow page and un-hide the header while frames were still being taken —
 * turning a watchdog into a corruption source.
 */
function armWatchdog(): void {
  clearWatchdog()
  watchdog = setTimeout(() => {
    watchdog = null
    restorePage()
  }, RESTORE_WATCHDOG_MS)
}

async function handle(request: ContentRequest): Promise<ContentResponse> {
  // `restore` ends the capture, so it disarms rather than re-arms.
  if (request.type === 'restore') {
    clearWatchdog()
    restorePage()
    return { ok: true }
  }

  // The clipboard sink. It lives here because this is a focused document and
  // the offscreen document -- where it used to live, failing every time -- can
  // never be one.
  //
  // Handled above the guard below, alongside `restore`, because it arrives
  // *after* `restore` by design: the page is put back before anything is
  // delivered, so `originalScrollY` is null and the guard would reject every
  // single copy with "capture abandoned". It also does not arm the watchdog:
  // it neither starts nor continues a capture, and there is no page state left
  // for a watchdog to protect.
  if (request.type === 'copyImage') {
    await copyDataUrlToClipboard(request.dataUrl)
    return { ok: true }
  }

  // Area selection. Handled above the guard below, with `measure` and
  // `copyImage`, because it *starts* a capture rather than continuing one: it
  // arrives with `originalScrollY` still null by definition, so behind the
  // guard every selection the extension ever offered would be refused with
  // "capture abandoned".
  //
  // Unlike `copyImage` it does arm the watchdog, because unlike `copyImage` it
  // leaves the page altered for as long as the user takes to drag -- and an
  // MV3 worker evicted during that drag would otherwise strand the overlay on
  // the page forever. `restorePage` tears the overlay down, so the existing
  // watchdog needs nothing new to cover this. The timer is cleared on the way
  // out: the reply ends the command, and a timer outliving it would scroll a
  // page that is no longer in a capture.
  //
  // A cancel is not a failure -- `{ ok: true, rect: null }`, and the service
  // worker delivers nothing and shows a neutral badge.
  if (request.type === 'selectArea') {
    armWatchdog()
    try {
      const rect = await selectArea(document)
      return { ok: true, rect }
    } finally {
      clearWatchdog()
    }
  }

  // The watchdog has already fired: this page is no longer in a capture, and
  // `originalScrollY === null` is how it knows -- only `measure` sets it, and
  // only `restore`/`restorePage` clear it. Obeying `hideFixed`/`scrollTo` from
  // here would do real damage rather than merely waste work. The header is
  // already un-hidden, so it would repeat down every remaining frame; one
  // frame would be taken at the original scroll position; and worst, the
  // trailing `restore` is now a no-op, so re-scrolling would strand the user's
  // page at the last frame's position -- violating the exact guarantee the
  // watchdog exists to enforce.
  //
  // `unwrap` in `runCapture` throws on this shape, which aborts the capture,
  // runs its `finally`, and shows the failure badge. No protocol change and no
  // check at every call site.
  //
  // `measure` is exempt: it is what starts a capture, so a null latch there is
  // the normal case, not an abandoned one. `copyImage` and `selectArea` are
  // exempt too, and have already returned above.
  //
  // This used to be reachable in ordinary use, not just after an eviction:
  // `finishCapture` ran the download and did not respond until it reached a
  // terminal state, with `restore` sent only afterwards, so a user with "Ask
  // where to save each file" enabled sat on an open native dialog and tripped
  // the watchdog on every capture. Delivery now happens after `restore`, which
  // disarms the watchdog, and the one command that follows it (`copyImage`)
  // neither arms it nor is subject to this guard -- so the dialog can stay
  // open as long as the user likes. The guard remains for the case it was
  // written for: an evicted service worker that never sends `restore` at all.
  if (request.type !== 'measure' && originalScrollY === null) {
    return { ok: false, error: 'capture abandoned; page already restored' }
  }

  armWatchdog()

  switch (request.type) {
    case 'measure': {
      const measurements = measurePage(window)
      // Only remember the position from the FIRST measure of a capture.
      // If the orchestrator ever re-sends `measure` mid-capture (e.g. a
      // retry) while the page has already been scrolled, overwriting this
      // would make `restore` land on the scrolled position instead of
      // where the user actually started — a real page alteration the spec
      // forbids. Each `measure` still returns fresh measurements; only the
      // remembered original position is sticky, and only `restore` (or the
      // watchdog) clears it.
      if (originalScrollY === null) {
        originalScrollY = measurements.scrollY
      }
      return { ok: true, measurements }
    }
    case 'hideFixed':
      hideFixedElements(document)
      return { ok: true }
    case 'scrollTo':
      await scrollToStep(window, request.y)
      return { ok: true }
  }
}

/**
 * Guards against duplicate registration. `chrome.scripting.executeScript`
 * re-runs this file on every capture, and the extension's isolated world
 * persists for the life of the page — so a second capture on the same page
 * would register a second listener, and both would answer every message:
 * duplicate `sendResponse`, duplicate `scrollTo`/`restore`, each with its own
 * latched `originalScrollY`. That only appears to work because `restore` is
 * idempotent and whichever listener scrolls last happens to win; correctness
 * by registration order is not correctness.
 *
 * On re-injection the new module instance simply does nothing — the original
 * instance keeps serving, with the state it already holds. That is safe
 * because `restore` (and the watchdog) clear that state at the end of every
 * capture, so the surviving instance is always clean when the next one starts.
 */
interface InjectionScope {
  __fullPageShotListenerInstalled?: true
}
const scope = globalThis as typeof globalThis & InjectionScope

if (scope.__fullPageShotListenerInstalled !== true) {
  scope.__fullPageShotListenerInstalled = true

  chrome.runtime.onMessage.addListener((request: ContentRequest, _sender, sendResponse) => {
    handle(request)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({ ok: false, error: String(error) } satisfies ContentResponse)
      })
    return true
  })
}

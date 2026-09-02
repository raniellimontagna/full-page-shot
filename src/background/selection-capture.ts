import type {
  ContentRequest,
  ContentResponse,
  CssRect,
  OffscreenRequest,
  OffscreenResponse,
} from '../shared/messages'
import type { EncodeOptions } from './capture-loop'

/**
 * Everything the selection path needs, injected — the same seam, and for the
 * same reason, as `CaptureDeps` and `ViewportCaptureDeps`: it is what makes a
 * path that spans an injection, a user gesture, a frame grab and an encode
 * testable without a browser.
 *
 * It is the viewport path's dependencies plus exactly two: the injection and
 * the page conversation. That pairing is the whole difference between the two
 * modes — this one asks the *user* where to crop, and asking means putting
 * code in the page.
 */
export interface SelectionCaptureDeps {
  /**
   * Puts the content script in the page. The full path's `executeScript` with
   * `files`, not a one-expression `func:` probe: the overlay is a real module
   * and the page needs the whole thing.
   */
  injectContentScript: () => Promise<void>
  sendToContent: (request: ContentRequest) => Promise<ContentResponse>
  captureVisibleTab: () => Promise<string>
  sendToOffscreen: (request: OffscreenRequest) => Promise<OffscreenResponse>
  ensureOffscreen: () => Promise<void>
  /**
   * The captured tab's `window.devicePixelRatio`. The frame comes back in
   * device pixels and the rect is in CSS pixels, so this is what reconciles
   * them — in the offscreen document, which does the conversion.
   */
  getDevicePixelRatio: () => Promise<number>
  /**
   * False once the user has switched tabs or windows. The same guard the other
   * two paths make, and it matters more here, not less: the gesture that
   * starts a selection is followed by a drag of arbitrary length, so the window
   * in which the user can switch tabs is as long as they care to make it.
   */
  isTabStillActive: () => Promise<boolean>
}

/**
 * What a selection capture produced — or why it produced nothing.
 *
 * A union rather than a nullable image, because "the user cancelled" is a
 * first-class outcome with its own badge, not a degenerate success and not an
 * error. Making the caller destructure it is the point: there is no way to
 * treat a cancel as a failure by accident.
 */
export type SelectionCaptureOutcome =
  | { status: 'cancelled' }
  | { status: 'captured'; clipboardDataUrl: string; downloadDataUrl: string }

/**
 * Asks the page for a rectangle.
 *
 * ## Which paths owe the page a `restore`, and why
 *
 * The content script mounts the overlay, removes it in its own `finally`, and
 * waits two `requestAnimationFrame`s for the removal to paint *before* it
 * replies. So a reply — a selection or a cancel, it makes no difference — is
 * proof that the overlay is already gone from the DOM and off the screen.
 * After one arrives there is nothing left to put back, which is why the
 * capture, encode and delivery steps below send no `restore` at all: it would
 * be a message about a state that no longer exists, and it would show up in
 * the page's message log as one.
 *
 * No reply is the opposite case. If the injection fails, if the message
 * channel dies (an evicted worker, a navigation mid-drag, a closed tab), or if
 * the content script answers `{ ok: false }` from its own catch, then nothing
 * proves the overlay came down — and an overlay left up is a dimmed page that
 * swallows every click, which is precisely the "a failed capture never leaves
 * the page altered" rule the whole project is built on. So those paths, and
 * only those, send `restore` on the way out, exactly as the full path does:
 * best-effort, its own failure swallowed, so the error the caller sees is
 * still the one that actually went wrong.
 *
 * (The page-side watchdog is the backstop under all of this: an overlay whose
 * service worker was evicted before it could send anything self-removes.
 * `restore` is the fast path, not the only one.)
 */
async function requestSelection(deps: SelectionCaptureDeps): Promise<CssRect | null> {
  let overlayIsDown = false
  try {
    await deps.injectContentScript()
    const reply = await deps.sendToContent({ type: 'selectArea' })
    if (!reply.ok) throw new Error(reply.error)
    overlayIsDown = true
    // `rect` is `CssRect | null | undefined`, and both of the last two mean
    // "no selection". Nothing may be cropped to a guess, so an answer that
    // carries no rectangle is a cancel.
    return reply.rect ?? null
  } finally {
    if (!overlayIsDown) {
      await deps.sendToContent({ type: 'restore' }).catch(() => {})
    }
  }
}

/**
 * Captures the region the user dragged out, and encodes it.
 *
 * Structurally the viewport path with a question in front of it: one frame of
 * what is on screen, encoded once, cropped to the rectangle the page reported.
 * The crop travels in CSS pixels the whole way — the offscreen document is the
 * only place that knows both the ratio and the frame's real dimensions, so it
 * is the only place that can convert without guessing.
 *
 * It cannot be truncated: one viewport is far inside Chrome's canvas ceilings
 * and a crop of it is smaller still, so no plan is made, nothing is clamped,
 * and the caller never has a `truncated` flag to report.
 */
export async function runSelectionCapture(
  deps: SelectionCaptureDeps,
  encode: EncodeOptions,
): Promise<SelectionCaptureOutcome> {
  const rect = await requestSelection(deps)
  // Nothing captured, nothing encoded, nothing delivered — and no offscreen
  // document created, which is why this returns before `ensureOffscreen`
  // rather than after it. A cancel should cost the browser nothing.
  if (rect === null) return { status: 'cancelled' }

  if (!(await deps.isTabStillActive())) {
    throw new Error('tab is no longer active')
  }

  const [dataUrl, devicePixelRatio] = await Promise.all([
    deps.captureVisibleTab(),
    // Never fatal, exactly as in viewport mode: a rejected ratio read must not
    // throw away a frame the user has already committed a drag to, and 1 means
    // "no downscale". The crop is in CSS px, so a wrong ratio would crop the
    // wrong region — but a ratio that cannot be read at all is not evidence of
    // any other value, and refusing to deliver would be the worse trade.
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
    crop: rect,
    scale: encode.scale,
    downloadFormat: encode.downloadFormat,
    devicePixelRatio,
  })
  if (!encoded.ok) throw new Error(encoded.error)
  if (!encoded.clipboardDataUrl || !encoded.downloadDataUrl) {
    throw new Error('the offscreen document returned no image')
  }

  return {
    status: 'captured',
    clipboardDataUrl: encoded.clipboardDataUrl,
    downloadDataUrl: encoded.downloadDataUrl,
  }
}

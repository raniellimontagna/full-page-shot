import type { PageMeasurements } from '../core/types'
import type { DownloadFormat, Scale } from './prefs'

/**
 * A rectangle in CSS pixels, relative to the viewport — i.e. exactly what a
 * `pointerdown`/`pointerup` pair on the page yields, before any device-pixel
 * scaling. Produced by the content script's selection overlay (Task 2) and
 * carried, unconverted, through `ContentResponse` and `encodeSingleFrame` —
 * the offscreen document is the one place that knows the captured frame's
 * `devicePixelRatio` and converts it there (Task 3).
 */
export interface CssRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Everything the offscreen document needs to turn a canvas into the two
 * delivered images. `devicePixelRatio` is read in the *captured tab* (the
 * offscreen document has one of its own, which is not the page's), because the
 * canvas is stitched in that tab's device pixels.
 */
export interface ExportRequestFields {
  scale: Scale
  downloadFormat: DownloadFormat
  devicePixelRatio: number
}

export type ContentRequest =
  | { type: 'measure' }
  | { type: 'hideFixed' }
  | { type: 'scrollTo'; y: number }
  | { type: 'restore' }
  // The clipboard sink. It lives in the content script because
  // `navigator.clipboard.write()` needs a focused document and the tab is one;
  // the offscreen document, where this used to live, can never be focused.
  // Note that this arrives *after* `restore` — the page is deliberately put
  // back before anything is delivered — so the content script's post-restore
  // guard exempts it, exactly as it exempts `measure`.
  | { type: 'copyImage'; dataUrl: string }
  // Selection mode's whole input step: mounts the overlay, waits for a drag
  // (or a cancel), and tears the overlay down before replying. See
  // `ContentResponse['rect']` for what comes back.
  | { type: 'selectArea' }

export type ContentResponse =
  | {
      ok: true
      measurements?: PageMeasurements
      // Only meaningful as the reply to `selectArea`. `undefined` on every
      // other response; `null` means the user cancelled (`Esc`, a click
      // without drag, or a sub-`MIN_SELECTION_PX` drag) — a normal outcome,
      // not a failure, so it travels inside the `ok: true` branch rather than
      // as an `ok: false` error. A present `CssRect` means a real selection.
      rect?: CssRect | null
    }
  | { ok: false; error: string }

export type OffscreenRequest =
  | { type: 'beginCapture'; width: number; height: number }
  | { type: 'addFrame'; dataUrl: string; destY: number; sourceHeight: number }
  | ({ type: 'finishCapture' } & ExportRequestFields)
  | { type: 'abortCapture' }
  // Viewport mode's whole protocol: one already-captured frame, encoded by
  // the same path as a stitched one. Deliberately independent of
  // `beginCapture`/`addFrame` — no capture need be in progress.
  //
  // `crop` is selection mode's addition: a CSS-px rect (from
  // `ContentResponse['rect']`) that this document converts to device pixels
  // using `devicePixelRatio` above and draws from before the scale/format
  // export runs (Task 3). Absent for plain viewport captures, which encode
  // the whole frame exactly as before.
  | ({ type: 'encodeSingleFrame'; dataUrl: string; crop?: CssRect } & ExportRequestFields)

// The two data URLs are only present on a successful `finishCapture` or
// `encodeSingleFrame`. The clipboard one is always PNG -- `ClipboardItem` with
// `image/png` is the only widely-pasteable image type -- while the download one
// carries the user's chosen format. When that format is PNG too, both fields
// hold the same string and the image is encoded once.
//
// The offscreen document is a canvas and nothing else. It used to run the
// sinks itself and report a `downloadPending` flag so the service worker knew
// when it was safe to close the document — an elaborate lifetime contract
// around a blob URL that could never work, because `chrome.downloads` does not
// exist in an offscreen document and `navigator.clipboard.write()` cannot
// succeed there either. With delivery moved out, nothing is ever in flight in
// the offscreen document once it has answered, so there is no flag to carry
// and the document can always be closed immediately.
export type OffscreenResponse =
  | { ok: true; clipboardDataUrl?: string; downloadDataUrl?: string }
  | { ok: false; error: string }

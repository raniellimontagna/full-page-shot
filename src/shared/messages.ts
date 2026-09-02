import type { PageMeasurements } from '../core/types'
import type { DownloadFormat, Scale } from './prefs'

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

export type ContentResponse =
  | { ok: true; measurements?: PageMeasurements }
  | { ok: false; error: string }

export type OffscreenRequest =
  | { type: 'beginCapture'; width: number; height: number }
  | { type: 'addFrame'; dataUrl: string; destY: number; sourceHeight: number }
  | ({ type: 'finishCapture' } & ExportRequestFields)
  | { type: 'abortCapture' }
  // Viewport mode's whole protocol: one already-captured frame, encoded by
  // the same path as a stitched one. Deliberately independent of
  // `beginCapture`/`addFrame` — no capture need be in progress.
  | ({ type: 'encodeSingleFrame'; dataUrl: string } & ExportRequestFields)

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

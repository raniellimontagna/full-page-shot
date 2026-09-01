import type { PageMeasurements } from '../core/types'

export type ContentRequest =
  | { type: 'measure' }
  | { type: 'hideFixed' }
  | { type: 'scrollTo'; y: number }
  | { type: 'restore' }

export type ContentResponse =
  | { ok: true; measurements?: PageMeasurements }
  | { ok: false; error: string }

export type OffscreenRequest =
  | { type: 'beginCapture'; width: number; height: number }
  | { type: 'addFrame'; dataUrl: string; destY: number; sourceHeight: number }
  | { type: 'finishCapture'; toClipboard: boolean; toDownload: boolean; filename: string }
  | { type: 'abortCapture' }

// `downloadPending` is only meaningful as a response to `finishCapture`
// (it is always `false` for the other request types). `true` means the
// offscreen document's download had not reached a terminal state when this
// response was sent, so the download is still writing in the background —
// the caller MUST NOT call `chrome.offscreen.closeDocument()` yet, since
// that would tear down the blob-URL registry mid-download. `false` means
// either there was no download to wait on, or it is genuinely finished, and
// the offscreen document may be closed immediately. This is deliberately a
// typed field rather than something the caller infers from timing.
export type OffscreenResponse = { ok: true; downloadPending: boolean } | { ok: false; error: string }

import type { PageMeasurements } from '../core/types'

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
  | { type: 'finishCapture' }
  | { type: 'abortCapture' }

// `dataUrl` is only present on a successful `finishCapture`: it is the
// stitched PNG, handed back to the service worker so *it* can deliver it.
//
// The offscreen document is a canvas and nothing else. It used to run the
// sinks itself and report a `downloadPending` flag so the service worker knew
// when it was safe to close the document — an elaborate lifetime contract
// around a blob URL that could never work, because `chrome.downloads` does not
// exist in an offscreen document and `navigator.clipboard.write()` cannot
// succeed there either. With delivery moved out, nothing is ever in flight in
// the offscreen document once it has answered, so there is no flag to carry
// and the document can always be closed immediately.
export type OffscreenResponse = { ok: true; dataUrl?: string } | { ok: false; error: string }

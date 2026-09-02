import type { ExportRequestFields, OffscreenRequest, OffscreenResponse } from '../shared/messages'
import { Stitcher, stitcherFromFrame, type ExportOptions } from './stitcher'

/**
 * The only part of `Stitcher` `exportBoth` actually needs.
 *
 * Kept as a structural interface (rather than taking a `Stitcher` directly)
 * so `exportBoth` can be exercised in a unit test with a fake that counts
 * calls to `export`, without pulling in `OffscreenCanvas` -- which does not
 * exist in the plain Node environment those tests run under.
 */
export interface Exportable {
  export(options: ExportOptions): Promise<Blob>
}

// Streamed across messages: the service worker sends one frame at a time,
// so the canvas must persist between `beginCapture`/`addFrame` calls rather
// than being rebuilt from an in-memory collection of frames.
let stitcher: Stitcher | null = null

/**
 * The only shape the stitched image can leave this document in.
 *
 * A `Blob` does not survive `chrome.runtime` messaging and a blob URL is
 * scoped to the document that created it — which is precisely the document the
 * service worker is about to close. A data URL is self-contained, so nothing
 * downstream depends on this document still being alive.
 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      resolve(String(reader.result))
    }
    reader.onerror = () => {
      reject(new Error('failed to read the stitched image'))
    }
    reader.readAsDataURL(blob)
  })
}

/**
 * Encodes one finished canvas into the clipboard image and the download image.
 *
 * PNG downloads encode once and hand the same string back twice: the two sinks
 * would otherwise pay for an identical encode of a possibly very large canvas.
 */
export async function exportBoth(
  stitcher: Exportable,
  { scale, downloadFormat, devicePixelRatio }: ExportRequestFields,
): Promise<OffscreenResponse> {
  const clipboardDataUrl = await blobToDataUrl(
    await stitcher.export({ scale, devicePixelRatio, format: 'png' }),
  )
  const downloadDataUrl =
    downloadFormat === 'png'
      ? clipboardDataUrl
      : await blobToDataUrl(await stitcher.export({ scale, devicePixelRatio, format: downloadFormat }))
  return { ok: true, clipboardDataUrl, downloadDataUrl }
}

async function handle(request: OffscreenRequest): Promise<OffscreenResponse> {
  switch (request.type) {
    case 'beginCapture':
      stitcher = new Stitcher(request.width, request.height)
      return { ok: true }
    case 'addFrame':
      if (!stitcher) return { ok: false, error: 'no capture in progress' }
      await stitcher.addFrame(request.dataUrl, request.destY, request.sourceHeight)
      return { ok: true }
    case 'finishCapture': {
      if (!stitcher) return { ok: false, error: 'no capture in progress' }
      try {
        // This document's whole job ends here: it hands back the image and
        // keeps nothing in flight, so the service worker may close it the
        // moment this reply lands. Delivery -- download in the service worker,
        // clipboard in the captured tab's content script -- happens in
        // contexts that can actually perform it.
        return await exportBoth(stitcher, request)
      } finally {
        stitcher = null
      }
    }
    case 'encodeSingleFrame': {
      // No `stitcher` state is touched: viewport mode never begins a capture,
      // and a full-page capture must not be disturbed if one is somehow live.
      return await exportBoth(await stitcherFromFrame(request.dataUrl), request)
    }
    case 'abortCapture':
      stitcher = null
      return { ok: true }
    default:
      // `handle` is only ever exhaustive against the declared
      // `OffscreenRequest` union, and `noImplicitReturns` is off. A message
      // from outside that contract (e.g. a `ContentRequest` mis-routed to
      // this listener) would otherwise fall through every case, resolve
      // `handle()` to `undefined`, and hand the caller `sendResponse(undefined)`
      // — silently breaking the `OffscreenResponse` contract instead of
      // failing loudly. `assertNever` both names the unknown type in the
      // response *and* makes the discriminated union exhaustive at compile
      // time: if a future `OffscreenRequest` variant is added without a
      // case here, `request` stops narrowing to `never` at this point and
      // the call below fails to typecheck.
      return assertNever(request)
  }
}

function assertNever(request: never): OffscreenResponse {
  const unexpected = request as { type?: unknown }
  return { ok: false, error: `unknown offscreen request type: ${JSON.stringify(unexpected?.type)}` }
}

// No end-to-end test hook here any more, deliberately. The suite needed the
// stitched pixels and the only production route to them -- the sinks -- could
// not work from this document, so a build-gated test-only message used to hand
// the image back. `finishCapture` now returns exactly that image as part of
// the shipped protocol, so the test-only path has nothing left to do and this
// file carries no test-only code at all. `tests/background/e2e-hook.test.ts`
// pins that by asserting on this file's source text, so keep it that way.
chrome.runtime.onMessage.addListener((request: OffscreenRequest, _sender, sendResponse) => {
  if (!('type' in request)) return false

  handle(request)
    .then(sendResponse)
    .catch((error: unknown) => {
      stitcher = null
      sendResponse({ ok: false, error: String(error) } satisfies OffscreenResponse)
    })
  return true
})

import type { OffscreenRequest, OffscreenResponse } from '../shared/messages'
import { copyToClipboard, downloadBlob } from './sinks'
import { Stitcher } from './stitcher'

// Streamed across messages: the service worker sends one frame at a time,
// so the canvas must persist between `beginCapture`/`addFrame` calls rather
// than being rebuilt from an in-memory collection of frames.
let stitcher: Stitcher | null = null

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
        const blob = await stitcher.toBlob()
        if (request.toClipboard) await copyToClipboard(blob)
        if (request.toDownload) await downloadBlob(blob, request.filename)
        return { ok: true }
      } finally {
        stitcher = null
      }
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

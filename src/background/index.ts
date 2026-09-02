// `?script&iife` is what actually gets the content script into `dist/`.
// CRXJS only bundles entry points it can reach from the manifest, and this
// content script is deliberately absent from it (it is injected on demand
// under `activeTab`, never declared statically) -- so without this import the
// build emits no content script at all and every capture fails at injection.
// The `iife` variant matters too: `chrome.scripting.executeScript` runs files
// as classic scripts, so an ESM chunk with `import` statements would throw.
// The import evaluates to the emitted file's path, resolved by the bundler,
// and CRXJS also appends that path to `web_accessible_resources` in the built
// manifest -- which is what `contentScriptPath()` below reads back.
//
// It targets `content-script.ts`, not `index.ts`, and that is load-bearing:
// two entry chunks both named `index.ts` make CRXJS point
// `service-worker-loader.js` at the content script's chunk instead of this
// one. See the comment in `src/content/content-script.ts`.
import CONTENT_SCRIPT_FILE from '../content/content-script.ts?script&iife'
import { runCapture } from './capture-loop'
import {
  badgeForDelivery,
  copyViaContentScript,
  deliverCapture,
  downloadDataUrl,
  BADGE_FAILURE,
} from './sinks'
import { buildFilename, isCapturableUrl, loadPrefs } from '../shared/prefs'
import type {
  ContentRequest,
  ContentResponse,
  OffscreenRequest,
  OffscreenResponse,
} from '../shared/messages'

// Emitted unhashed by the Rollup input registered in `vite.config.ts`, so this
// literal is stable; verified against `dist/` on every build.
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Resolves the path to inject. Never hardcode it: the emitted name is chosen
 * by the bundler, so the only trustworthy sources are the build-time import
 * above and the manifest CRXJS wrote. This checks the second against the
 * first, so a build that stops emitting or registering the content script
 * fails here with a clear message instead of at `executeScript` with an
 * opaque "Could not load file" -- the exact failure that shipped silently
 * before, with a green test suite.
 */
function contentScriptPath(): string {
  const resources = (chrome.runtime.getManifest().web_accessible_resources ?? []).flatMap((entry) =>
    typeof entry === 'object' && entry !== null && 'resources' in entry ? (entry.resources ?? []) : [],
  )
  if (!resources.includes(CONTENT_SCRIPT_FILE)) {
    throw new Error(
      `full-page-shot: content script "${CONTENT_SCRIPT_FILE}" is not listed in ` +
        `web_accessible_resources (found: ${resources.join(', ') || 'none'}) -- ` +
        'the build did not emit it.',
    )
  }
  return CONTENT_SCRIPT_FILE
}

// `createDocument` rejects if a document already exists or is mid-creation,
// and two rapid action clicks can race. Sharing the in-flight promise makes
// the second caller await the first instead of blowing up.
let creatingOffscreen: Promise<void> | null = null

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  })
  if (existing.length > 0) return

  // BLOBS, not CLIPBOARD. The document exists to draw frames onto a canvas and
  // read that canvas back as a PNG blob, and that is now all it does. It used
  // to declare CLIPBOARD with a comment claiming the reason was what made
  // `navigator.clipboard.write()` work there -- which was simply false: the
  // reason grants the API, never the focus it requires, and an offscreen
  // document can never be focused. The copy now happens in the captured tab.
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: 'Stitch the captured frames into a single PNG on a canvas.',
    })
    .finally(() => {
      creatingOffscreen = null
    })
  await creatingOffscreen
}

/**
 * Closes the offscreen document.
 *
 * Unconditional, and that is the point of this whole task. The document used
 * to run the sinks, so closing it could truncate a download reading a blob URL
 * out of it -- hence a `downloadPending` flag on the wire and a poll over
 * `chrome.downloads.search` before daring to close. None of that machinery
 * could ever have run (`chrome.downloads` is undefined in an offscreen
 * document), and none of it is needed now: the document hands back a
 * self-contained data URL and keeps nothing in flight, so there is never
 * anything to wait for.
 *
 * Idempotent, because it is called both on the happy path -- as early as
 * possible, so a full-page canvas is not held in memory while a download runs
 * -- and from `finally`, so no failure can strand the document.
 */
function makeOffscreenCloser(): () => Promise<void> {
  let closed = false
  return async () => {
    if (closed) return
    closed = true
    await chrome.offscreen.closeDocument().catch(() => {})
  }
}

/**
 * Never throws. `setBadgeText`/`setBadgeBackgroundColor` reject if the tab has
 * closed, which is entirely possible mid-capture -- and this is called from
 * the failure path, where an escaping rejection would skip the offscreen
 * cleanup that follows it and leak the document (plus an unhandled rejection).
 * A badge is cosmetic; it must never be able to take down cleanup.
 */
async function setBadge(tabId: number, text: string, color: string): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color })
    await chrome.action.setBadgeText({ tabId, text })
  } catch {
    return
  }
  setTimeout(() => void chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 3000)
}

/**
 * The whole capture, from injection to delivery, for one tab.
 *
 * Extracted out of the `onClicked` listener so the end-to-end suite can drive
 * *this* function -- the same code a real toolbar click runs -- instead of a
 * parallel re-implementation of the wiring. A test-only re-implementation is
 * exactly the kind of harness that stays green while the real path rots, and
 * this project has already shipped two such bugs. Nothing else about the
 * behaviour changed: the listener below is now a one-line call.
 */
export async function captureTab(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id
  // Captured at click time. Every later window-scoped call is pinned to this
  // window rather than to whatever "current" means later on.
  const windowId = tab.windowId
  const url = tab.url
  if (tabId === undefined) return
  if (!isCapturableUrl(url)) {
    await setBadge(tabId, BADGE_FAILURE.text, BADGE_FAILURE.color)
    return
  }

  const closeOffscreen = makeOffscreenCloser()
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [contentScriptPath()],
    })

    const prefs = await loadPrefs()
    const { dataUrl } = await runCapture(tabId, {
      sendToContent: (id, request: ContentRequest) =>
        chrome.tabs.sendMessage(id, request) as Promise<ContentResponse>,
      sendToOffscreen: (request: OffscreenRequest) =>
        chrome.runtime.sendMessage(request) as Promise<OffscreenResponse>,
      // Pinned to the captured window. Called without a windowId this grabs
      // the *last focused* window, so merely focusing a second window would
      // start splicing that window's tab into the screenshot.
      captureVisibleTab: () => chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
      ensureOffscreen,
      // Asks the tab about itself rather than asking which tab is "current".
      // `chrome.tabs.query({ active: true, currentWindow: true })` resolves
      // "current window" to the last focused one when called from a service
      // worker, so focusing any other window aborted a perfectly valid
      // capture. This and the windowId above are one fix: the old abort was
      // load-bearing precisely because captureVisibleTab was unpinned, so
      // removing the false aborts without pinning the capture would have
      // traded a nuisance for a wrong screenshot.
      isTabStillActive: async () => (await chrome.tabs.get(tabId)).active,
      delay,
    })

    // The image is a self-contained data URL and the canvas has done its job,
    // so the document is closed here rather than after delivery: a stitched
    // full-page canvas is tens of megabytes, and nothing below needs it.
    await closeOffscreen()

    // Both sinks run, independently, whatever either one does -- and the badge
    // says which of those two things happened. `runCapture` has already sent
    // `restore`, so the page is back where the user left it before a single
    // byte is delivered.
    const delivery = await deliverCapture(prefs, {
      copy: () => copyViaContentScript(tabId, dataUrl),
      download: () => downloadDataUrl(dataUrl, buildFilename(new Date(), new URL(url).hostname)),
    })
    const badge = badgeForDelivery(delivery)
    await setBadge(tabId, badge.text, badge.color)
  } catch (error) {
    console.error('[full-page-shot]', error)
    await setBadge(tabId, BADGE_FAILURE.text, BADGE_FAILURE.color)
  } finally {
    // In `finally` so no failure between here and the badge can skip it and
    // strand the offscreen document. A no-op on the happy path, where it has
    // already been closed above.
    await closeOffscreen()
  }
}

chrome.action.onClicked.addListener((tab) => {
  void captureTab(tab)
})

// ---------------------------------------------------------------------------
// End-to-end test hook.
//
// `import.meta.env.VITE_FPS_E2E` is inlined as a string literal at build time,
// so this whole block is dead code the bundler drops from the production
// build; only `pnpm build:e2e` (which sets the variable and writes to
// `dist-e2e/`) emits it. `tests/background/e2e-hook.test.ts` asserts the gate
// and `pnpm build` is grepped for the symbol, so a shipped hook cannot pass
// unnoticed.
//
// The hook deliberately instruments only *Chrome APIs*, never the product's
// own functions: it wraps `captureVisibleTab` to count real frames,
// `downloads.download` to count real download requests and
// `runtime.sendMessage` to read the stitched image out of the `finishCapture`
// reply, then calls `captureTab` -- the exact function a toolbar click runs.
// The badge is read back rather than an error being returned, because the
// badge is the real user-visible success signal and asserting on it tests more.
//
// There is no longer a `mode` argument. It used to divert the final
// `finishCapture` to a test-only `exportCapture` message in the offscreen
// document, because the suite needed the stitched pixels and the sinks could
// not produce them. `finishCapture` now returns that image in production, so
// every capture's pixels come back through the shipped protocol and the
// offscreen document carries no test-only code at all.
// ---------------------------------------------------------------------------
if (import.meta.env.VITE_FPS_E2E === '1') {
  interface CaptureProbe {
    /** Whether a tab matching the requested URL was found and captured. */
    badge: string
    /** How many times `chrome.tabs.captureVisibleTab` actually ran. */
    frames: number
    /** Wall time of the whole capture, used to prove single-frame captures. */
    elapsedMs: number
    /**
     * How many times `chrome.downloads.download` was actually called. The
     * download sink is a service-worker API call now, so "was a download even
     * requested?" is answerable by watching Chrome rather than by trusting a
     * flag the product reports about itself.
     */
    downloadRequests: number
    /** Whether the offscreen document was closed before the hook returned. */
    offscreenClosed: boolean
    /**
     * Whatever `captureTab` logged on its failure path. The product swallows
     * the error (a badge is all the user gets), so without this a failing
     * capture is indistinguishable from a mysterious one and the suite could
     * only report "it went red".
     */
    error: string | null
    /** The stitched PNG the offscreen document handed back, as a data URL. */
    dataUrl: string | null
  }

  const probeCapture = async (targetUrl: string): Promise<CaptureProbe> => {
    const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === targetUrl)
    if (!tab || tab.id === undefined) throw new Error(`no tab at ${targetUrl}`)

    const realCapture = chrome.tabs.captureVisibleTab
    const realSend = chrome.runtime.sendMessage
    const realClose = chrome.offscreen.closeDocument
    const realDownload = chrome.downloads.download
    const realConsoleError = console.error

    let frames = 0
    let downloadRequests = 0
    let dataUrl: string | null = null
    let offscreenClosed = false
    let error: string | null = null

    const tabsApi = chrome.tabs as unknown as Record<string, unknown>
    const runtimeApi = chrome.runtime as unknown as Record<string, unknown>
    const offscreenApi = chrome.offscreen as unknown as Record<string, unknown>
    const downloadsApi = chrome.downloads as unknown as Record<string, unknown>

    tabsApi.captureVisibleTab = (...args: unknown[]): unknown => {
      frames += 1
      return (realCapture as (...a: unknown[]) => unknown).apply(chrome.tabs, args)
    }
    runtimeApi.sendMessage = (...args: unknown[]): unknown => {
      const request = args[0] as { type?: string } | undefined
      const result = (realSend as (...a: unknown[]) => unknown).apply(chrome.runtime, args)
      if (request?.type === 'finishCapture' && result instanceof Promise) {
        void result.then((response: unknown) => {
          const reply = response as { ok?: boolean; dataUrl?: string }
          dataUrl = reply?.ok === true ? (reply.dataUrl ?? null) : null
        })
      }
      return result
    }
    offscreenApi.closeDocument = (...args: unknown[]): unknown => {
      offscreenClosed = true
      return (realClose as (...a: unknown[]) => unknown).apply(chrome.offscreen, args)
    }
    downloadsApi.download = (...args: unknown[]): unknown => {
      downloadRequests += 1
      return (realDownload as (...a: unknown[]) => unknown).apply(chrome.downloads, args)
    }

    console.error = (...args: unknown[]): void => {
      error = args.map((value) => (value instanceof Error ? value.message : String(value))).join(' ')
      realConsoleError.apply(console, args)
    }

    const startedAt = Date.now()
    try {
      await captureTab(tab)
    } finally {
      tabsApi.captureVisibleTab = realCapture
      runtimeApi.sendMessage = realSend
      offscreenApi.closeDocument = realClose
      downloadsApi.download = realDownload
      console.error = realConsoleError
    }
    const elapsedMs = Date.now() - startedAt

    return {
      badge: await chrome.action.getBadgeText({ tabId: tab.id }),
      frames,
      elapsedMs,
      downloadRequests,
      offscreenClosed,
      dataUrl,
      error,
    }
  }

  Object.assign(globalThis, {
    __fpsCaptureForTest: probeCapture,
    /** Sets the delivery preferences through the same storage the product reads. */
    __fpsSetPrefsForTest: (prefs: { toClipboard: boolean; toDownload: boolean }) =>
      chrome.storage.sync.set(prefs),
    /**
     * One raw `captureVisibleTab` frame, for the fractional-DPI question: does
     * Chrome's own frame height equal `Math.round(viewportHeight * dpr)`?
     */
    __fpsGrabFrameForTest: async (targetUrl: string): Promise<string> => {
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === targetUrl)
      if (!tab || tab.windowId === undefined) throw new Error(`no tab at ${targetUrl}`)
      return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
    },
  })
}

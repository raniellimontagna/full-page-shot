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

/** How often to re-check whether a still-writing download has drained. */
const DOWNLOAD_DRAIN_POLL_MS = 1_000
/** How long to keep polling before giving up and leaving the document open. */
const DOWNLOAD_DRAIN_TIMEOUT_MS = 60_000

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

  // CLIPBOARD is required, not decorative: navigator.clipboard.write() from an
  // offscreen document is rejected unless the document declared this reason.
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: 'Stitch captured frames into a single image and copy it to the clipboard.',
    })
    .finally(() => {
      creatingOffscreen = null
    })
  await creatingOffscreen
}

/**
 * Closes the offscreen document, but only once nothing is still downloading.
 *
 * The offscreen document owns the blob URL `chrome.downloads` is reading the
 * PNG out of. Tearing it down mid-write truncates the file -- a corrupt
 * screenshot with no error anywhere. `downloadPending` is the offscreen
 * document telling us it never observed the download reach a terminal state,
 * so this waits it out rather than closing on faith.
 *
 * The poll deliberately queries *all* in-progress downloads rather than trying
 * to match ours by filename: a filename query that fails to match returns an
 * empty set, which is indistinguishable from "finished" and would close the
 * document exactly when it is least safe. An unrelated download can therefore
 * delay the close, which costs nothing but a hidden idle document.
 *
 * If the wait times out we leave the document open. That is the safe end of
 * the trade: a lingering offscreen document is reused by the next capture's
 * `ensureOffscreen` and closed when that one finishes cleanly, whereas a
 * premature close is unrecoverable.
 */
async function releaseOffscreen(downloadPending: boolean): Promise<void> {
  if (downloadPending && !(await waitForDownloadsToDrain())) {
    console.warn(
      'full-page-shot: a download was still writing after ' +
        `${DOWNLOAD_DRAIN_TIMEOUT_MS}ms; leaving the offscreen document open so the ` +
        'blob URL it is being read from stays valid.',
    )
    return
  }
  await chrome.offscreen.closeDocument().catch(() => {})
}

async function waitForDownloadsToDrain(): Promise<boolean> {
  const deadline = Date.now() + DOWNLOAD_DRAIN_TIMEOUT_MS
  for (;;) {
    const inFlight = await chrome.downloads.search({ state: 'in_progress' })
    if (inFlight.length === 0) return true
    if (Date.now() >= deadline) return false
    await delay(DOWNLOAD_DRAIN_POLL_MS)
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

chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    const tabId = tab.id
    // Captured at click time. Every later window-scoped call is pinned to this
    // window rather than to whatever "current" means later on.
    const windowId = tab.windowId
    const url = tab.url
    if (tabId === undefined) return
    if (!isCapturableUrl(url)) {
      await setBadge(tabId, '✕', '#b3261e')
      return
    }

    let downloadPending = false
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [contentScriptPath()],
      })

      const outcome = await runCapture(tabId, {
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
        prefs: await loadPrefs(),
        filename: buildFilename(new Date(), new URL(url).hostname),
        delay,
      })

      downloadPending = outcome.downloadPending
      await setBadge(tabId, '✓', '#1e8e3e')
    } catch (error) {
      console.error('[full-page-shot]', error)
      await setBadge(tabId, '✕', '#b3261e')
      // `downloadPending` stays false: `runCapture` only throws before
      // `finishCapture` succeeds, and a download that failed outright rejects
      // rather than resolving, so there is no live blob URL to protect.
    } finally {
      // In `finally` so no failure between here and the badge can skip it and
      // strand the offscreen document. Deliberately after the badge: the user
      // has their result, and this may block waiting on a slow write.
      //
      // `.catch` because `releaseOffscreen` can still reject: the
      // `chrome.downloads.search` poll inside `waitForDownloadsToDrain` is
      // unguarded, and this IIFE has no outer handler, so a downloads-API
      // error while `downloadPending` is true would surface as an unhandled
      // rejection. Failing to close the document is the benign outcome
      // anyway -- the next capture reuses it.
      await releaseOffscreen(downloadPending).catch(() => {})
    }
  })()
})

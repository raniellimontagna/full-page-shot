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
import { runCapture, type EncodeOptions } from './capture-loop'
import { runViewportCapture } from './viewport-capture'
import { runSelectionCapture } from './selection-capture'
import {
  badgeForCancelledCapture,
  badgeForCapture,
  copyViaContentScript,
  deliverImages,
  downloadDataUrl,
  BADGE_FAILURE,
  type Badge,
  type CaptureImages,
} from './sinks'
import { createSingleFlight } from './single-flight'
import { buildFilename, isCapturableUrl, loadPrefs, resolveCaptureMode } from '../shared/prefs'
import type { CaptureMode, Prefs } from '../shared/prefs'
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
async function setBadge(tabId: number, badge: Badge): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color })
    await chrome.action.setBadgeText({ tabId, text: badge.text })
  } catch {
    return
  }
  setTimeout(
    () => void chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}),
    // Each badge decides how long it deserves; only the cancel badge asks for
    // anything but the default.
    badge.clearAfterMs ?? BADGE_CLEAR_MS,
  )
}

/** How long a badge that reports a real outcome stays up. */
const BADGE_CLEAR_MS = 3000

const captureSingleFlight = createSingleFlight()

/**
 * The whole capture, from injection to delivery, for one tab.
 *
 * Entry point and gatekeeper: it validates the tab, then hands the actual work
 * to `runOneCapture` through `captureSingleFlight`, which refuses a capture
 * while another one is running (see `single-flight.ts` for why overlapping
 * captures corrupt each other).
 *
 * Extracted out of the `onClicked` listener so the end-to-end suite can drive
 * *this* function -- the same code a real toolbar click runs -- instead of a
 * parallel re-implementation of the wiring. A test-only re-implementation is
 * exactly the kind of harness that stays green while the real path rots, and
 * this project has already shipped two such bugs. Nothing else about the
 * behaviour changed: the listener below is now a one-line call.
 */
export async function captureTab(tab: chrome.tabs.Tab, mode?: CaptureMode): Promise<void> {
  const tabId = tab.id
  // Captured at click time. Every later window-scoped call is pinned to this
  // window rather than to whatever "current" means later on.
  const windowId = tab.windowId
  const url = tab.url
  if (tabId === undefined) return
  if (!isCapturableUrl(url)) {
    await setBadge(tabId, BADGE_FAILURE)
    return
  }

  await captureSingleFlight(
    () => runOneCapture(tabId, windowId, url, mode),
    async () => {
      // Not silent, and not a ✓. The second click did not capture anything, so
      // saying so is the honest signal -- and the page is left completely
      // untouched, which is why this branch runs before a single injection.
      console.warn(
        '[full-page-shot] a capture is already running; ignoring this one. ' +
          'Captures share one offscreen canvas, so they cannot overlap.',
      )
      await setBadge(tabId, BADGE_FAILURE)
    },
  )
}

/**
 * The captured tab's `window.devicePixelRatio`, without injecting the content
 * script.
 *
 * The full path gets this for free: the content script reports it as part of
 * `measure`. The viewport path deliberately injects no content script at all,
 * so it asks for this one number with a one-expression `func:` injection --
 * cheap, self-contained, and it leaves nothing behind in the page. Anything
 * unusable falls back to 1, which is the ratio of an ordinary display and the
 * value at which the 1x downscale is a no-op: a bad reading must never scale
 * the image by a garbage factor.
 *
 * "Unusable" includes the injection itself failing, which is why the throw is
 * caught here rather than left to the caller. On the full path a failed
 * injection is fatal and should be -- no measure means no plan. Here the frame
 * has already been captured from a page nothing altered, so refusing to
 * deliver it would trade a good screenshot for a red badge over a number whose
 * safe default is known.
 */
async function tabDevicePixelRatio(tabId: number): Promise<number> {
  let value: unknown
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.devicePixelRatio,
    })
    value = results[0]?.result
  } catch (error) {
    console.warn('[full-page-shot] could not inject the devicePixelRatio probe', error)
    return 1
  }
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
}

async function runOneCapture(
  tabId: number,
  windowId: number,
  url: string,
  requestedMode: CaptureMode | undefined,
): Promise<void> {
  const closeOffscreen = makeOffscreenCloser()
  try {
    const prefs = await loadPrefs()
    const mode = resolveCaptureMode(requestedMode, prefs)
    const encode: EncodeOptions = { scale: prefs.scale, downloadFormat: prefs.downloadFormat }

    // Pinned to the captured window. Called without a windowId this grabs the
    // *last focused* window, so merely focusing a second window would start
    // splicing that window's tab into the screenshot.
    const captureVisibleTab = (): Promise<string> =>
      chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
    const sendToOffscreen = (request: OffscreenRequest): Promise<OffscreenResponse> =>
      chrome.runtime.sendMessage(request) as Promise<OffscreenResponse>

    let images: CaptureImages
    let truncated = false

    if (mode === 'selection') {
      const outcome = await runSelectionCapture(
        {
          // The full path's injection, verbatim -- the overlay is a real
          // module, not the one-expression `func:` probe the viewport path
          // gets away with.
          injectContentScript: async () => {
            await chrome.scripting.executeScript({
              target: { tabId },
              files: [contentScriptPath()],
            })
          },
          sendToContent: (request: ContentRequest) =>
            chrome.tabs.sendMessage(tabId, request) as Promise<ContentResponse>,
          captureVisibleTab,
          sendToOffscreen,
          ensureOffscreen,
          getDevicePixelRatio: () => tabDevicePixelRatio(tabId),
          isTabStillActive: async () => (await chrome.tabs.get(tabId)).active,
        },
        encode,
      )

      // Cancel is not failure. The user pressed Esc, clicked without dragging,
      // or drew something too small to be a region: nothing was captured, so
      // there is nothing to name, deliver or badge as an outcome. Returning
      // here skips the whole delivery block -- and the `finally` below still
      // runs, closing an offscreen document that in this case was never even
      // created.
      if (outcome.status === 'cancelled') {
        await setBadge(tabId, badgeForCancelledCapture())
        return
      }
      images = outcome
    } else if (mode === 'viewport') {
      images = await runViewportCapture(
        {
          captureVisibleTab,
          sendToOffscreen,
          ensureOffscreen,
          getDevicePixelRatio: () => tabDevicePixelRatio(tabId),
          // The same check the full path makes before every frame, and for the
          // same reason: captureVisibleTab returns whatever is on screen now,
          // not what was on screen when the user asked.
          isTabStillActive: async () => (await chrome.tabs.get(tabId)).active,
        },
        encode,
      )
    } else {
      images = await runFullPageCapture(
        tabId,
        { captureVisibleTab, sendToOffscreen },
        encode,
        (result) => {
          truncated = result
        },
      )
    }

    // The images are self-contained data URLs and the canvas has done its job,
    // so the document is closed here rather than after delivery: a stitched
    // full-page canvas is tens of megabytes, and nothing below needs it.
    await closeOffscreen()

    // Both sinks run, independently, whatever either one does -- and the badge
    // says which of those two things happened. All three modes reach this
    // point with the page already exactly as the user left it: the full path
    // has already sent `restore`, the viewport path never altered the page at
    // all, and the selection path's overlay came down -- painted away, per
    // `selectArea`'s two-frame wait -- before its content script even replied.
    // So the page is untouched before a single byte is delivered.
    const delivery = await deliverImages(
      prefs,
      images,
      buildFilename(new Date(), new URL(url).hostname, { mode, format: prefs.downloadFormat }),
      {
        copy: (dataUrl) => copyViaContentScript(tabId, dataUrl),
        download: (dataUrl, filename) => downloadDataUrl(dataUrl, filename),
      },
    )

    await setBadge(tabId, badgeForCapture(delivery, truncated))
  } catch (error) {
    console.error('[full-page-shot]', error)
    await setBadge(tabId, BADGE_FAILURE)
  } finally {
    // In `finally` so no failure between here and the badge can skip it and
    // strand the offscreen document. A no-op on the happy path, where it has
    // already been closed above.
    await closeOffscreen()
  }
}

/**
 * The full-page path: inject, measure, scroll, stitch.
 *
 * Unchanged from 1.0.0 apart from what it is handed (the user's scale and
 * format) and what it hands back (two images instead of one). It reports
 * truncation through a callback because that fact belongs to the badge, which
 * `runOneCapture` owns.
 */
async function runFullPageCapture(
  tabId: number,
  io: {
    captureVisibleTab: () => Promise<string>
    sendToOffscreen: (request: OffscreenRequest) => Promise<OffscreenResponse>
  },
  encode: EncodeOptions,
  reportTruncated: (truncated: boolean) => void,
): Promise<CaptureImages> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [contentScriptPath()],
  })

  const {
    clipboardDataUrl,
    downloadDataUrl: encodedDataUrl,
    truncated,
    canvasWidth,
    canvasHeight,
  } = await runCapture(
    tabId,
    {
      sendToContent: (id, request: ContentRequest) =>
        chrome.tabs.sendMessage(id, request) as Promise<ContentResponse>,
      sendToOffscreen: io.sendToOffscreen,
      captureVisibleTab: io.captureVisibleTab,
      ensureOffscreen,
      // Asks the tab about itself rather than asking which tab is "current".
      // `chrome.tabs.query({ active: true, currentWindow: true })` resolves
      // "current window" to the last focused one when called from a service
      // worker, so focusing any other window aborted a perfectly valid
      // capture. This and the pinned windowId are one fix: the old abort was
      // load-bearing precisely because captureVisibleTab was unpinned, so
      // removing the false aborts without pinning the capture would have
      // traded a nuisance for a wrong screenshot.
      isTabStillActive: async () => (await chrome.tabs.get(tabId)).active,
      delay,
    },
    encode,
  )

  // The planner clamps pages that would exceed Chrome's canvas ceilings, so
  // what was delivered is the top of the page rather than the whole thing.
  // The badge says so (amber, not ✓) and the log says by how much -- the
  // user's next question is "how much did I lose?", and only these numbers
  // can answer it.
  if (truncated) {
    console.warn(
      `full-page-shot: the page exceeded Chrome's canvas limits and was captured up to ` +
        `${String(canvasWidth)}x${String(canvasHeight)} device px; the delivered image is ` +
        'the top of the page, not all of it',
    )
  }
  reportTruncated(truncated)

  return { clipboardDataUrl, downloadDataUrl: encodedDataUrl }
}

// ---------------------------------------------------------------------------
// Mode selection.
//
// Three entry points, one function. The toolbar click (and its
// `_execute_action` shortcut) names no mode, so it takes the user's default;
// the three menu items and the `capture-viewport`/`capture-selection` shortcuts
// each name one, which overrides that default for this capture only.
// ---------------------------------------------------------------------------

const MENU_FULL = 'capture-full'
const MENU_VIEWPORT = 'capture-viewport'
const MENU_SELECTION = 'capture-selection'

/**
 * The menu ids that name a mode, and the mode each names.
 *
 * A lookup rather than a chain of `if`s so the context-menu listener and the
 * command listener dispatch through the *same* table -- `capture-viewport` is
 * deliberately both a menu id and a command name, so the two entry points
 * cannot drift apart.
 */
const MODE_BY_ID: Record<string, CaptureMode> = {
  [MENU_FULL]: 'full',
  [MENU_VIEWPORT]: 'viewport',
  [MENU_SELECTION]: 'selection',
}

/**
 * (Re)creates the action's right-click menu.
 *
 * `removeAll` first, unconditionally: `contextMenus.create` fails with
 * "Cannot create item with duplicate id" if the item already exists, and it
 * survives across a service-worker restart when the extension is merely
 * reloaded rather than reinstalled. Removing first makes this idempotent, so
 * running it on both `onInstalled` and `onStartup` is safe.
 *
 * `contexts: ['action']` scopes all three items to the toolbar icon. They never
 * appear on the page itself, so this adds nothing to a right-click in the
 * content the user is reading.
 */
function createContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_FULL, title: 'Capture full page', contexts: ['action'] })
    chrome.contextMenus.create({
      id: MENU_VIEWPORT,
      title: 'Capture visible area',
      contexts: ['action'],
    })
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: 'Capture selected area',
      contexts: ['action'],
    })
  })
}

chrome.runtime.onInstalled.addListener(createContextMenus)
// Defensively, too: `onInstalled` fires once per install/update, and a profile
// whose menus were somehow lost would otherwise never get them back until the
// next update.
chrome.runtime.onStartup.addListener(createContextMenus)

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const mode = MODE_BY_ID[String(info.menuItemId)]
  if (!mode || !tab) return
  void captureTab(tab, mode)
})

chrome.commands.onCommand.addListener((command, tab) => {
  const mode = MODE_BY_ID[command]
  // `_execute_action` never reaches here (Chrome fires `action.onClicked` for
  // it), so an unknown command is genuinely not ours.
  if (!mode || !tab) return
  void captureTab(tab, mode)
})

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
    /** The PNG handed back for the clipboard, as a data URL. Alias of `clipboardDataUrl`. */
    dataUrl: string | null
    /** The clipboard image, always PNG, whichever path produced it. */
    clipboardDataUrl: string | null
    /** The download image, encoded in the user's chosen format. */
    downloadDataUrl: string | null
    /**
     * The `type` of every message the service worker sent to the page, in
     * order. This is what makes "the viewport path never touches the page" an
     * observation rather than a claim: `measure`, `hideFixed`, `scrollTo` and
     * `restore` are the four messages that alter or interrogate the document,
     * and a viewport capture must send none of them.
     */
    contentMessages: string[]
    /**
     * Whether `chrome.scripting.executeScript` was called with `files` -- i.e.
     * whether the content script was injected at all. The one-expression
     * `func:` injection the viewport path uses to read `devicePixelRatio` is
     * deliberately not counted: it leaves nothing behind in the page.
     */
    contentScriptInjected: boolean
  }

  const probeCapture = async (targetUrl: string, mode?: CaptureMode): Promise<CaptureProbe> => {
    const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === targetUrl)
    if (!tab || tab.id === undefined) throw new Error(`no tab at ${targetUrl}`)

    const realCapture = chrome.tabs.captureVisibleTab
    const realTabsSend = chrome.tabs.sendMessage
    const realExecuteScript = chrome.scripting.executeScript
    const realSend = chrome.runtime.sendMessage
    const realClose = chrome.offscreen.closeDocument
    const realDownload = chrome.downloads.download
    const realConsoleError = console.error

    let frames = 0
    let downloadRequests = 0
    let clipboardDataUrl: string | null = null
    let downloadDataUrlSeen: string | null = null
    let offscreenClosed = false
    let error: string | null = null
    const contentMessages: string[] = []
    let contentScriptInjected = false

    const tabsApi = chrome.tabs as unknown as Record<string, unknown>
    const runtimeApi = chrome.runtime as unknown as Record<string, unknown>
    const offscreenApi = chrome.offscreen as unknown as Record<string, unknown>
    const downloadsApi = chrome.downloads as unknown as Record<string, unknown>
    const scriptingApi = chrome.scripting as unknown as Record<string, unknown>

    tabsApi.captureVisibleTab = (...args: unknown[]): unknown => {
      frames += 1
      return (realCapture as (...a: unknown[]) => unknown).apply(chrome.tabs, args)
    }
    tabsApi.sendMessage = (...args: unknown[]): unknown => {
      const request = args[1] as { type?: string } | undefined
      if (typeof request?.type === 'string') contentMessages.push(request.type)
      return (realTabsSend as (...a: unknown[]) => unknown).apply(chrome.tabs, args)
    }
    scriptingApi.executeScript = (...args: unknown[]): unknown => {
      const injection = args[0] as { files?: unknown } | undefined
      if (injection?.files !== undefined) contentScriptInjected = true
      return (realExecuteScript as (...a: unknown[]) => unknown).apply(chrome.scripting, args)
    }
    runtimeApi.sendMessage = (...args: unknown[]): unknown => {
      const request = args[0] as { type?: string } | undefined
      const result = (realSend as (...a: unknown[]) => unknown).apply(chrome.runtime, args)
      // Both of the offscreen document's export replies, because the two
      // capture paths use different ones: the full page finishes a stitch,
      // the viewport encodes a single frame. Reading only the first would
      // report a viewport capture as having produced no image at all.
      if (
        (request?.type === 'finishCapture' || request?.type === 'encodeSingleFrame') &&
        result instanceof Promise
      ) {
        void result.then((response: unknown) => {
          const reply = response as {
            ok?: boolean
            clipboardDataUrl?: string
            downloadDataUrl?: string
          }
          const ok = reply?.ok === true
          clipboardDataUrl = ok ? (reply.clipboardDataUrl ?? null) : null
          downloadDataUrlSeen = ok ? (reply.downloadDataUrl ?? null) : null
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
      await captureTab(tab, mode)
    } finally {
      tabsApi.captureVisibleTab = realCapture
      tabsApi.sendMessage = realTabsSend
      scriptingApi.executeScript = realExecuteScript
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
      dataUrl: clipboardDataUrl,
      clipboardDataUrl,
      downloadDataUrl: downloadDataUrlSeen,
      contentMessages,
      contentScriptInjected,
      error,
    }
  }

  Object.assign(globalThis, {
    __fpsCaptureForTest: probeCapture,
    /**
     * Sets preferences through the same storage the product reads. Partial:
     * `chrome.storage.sync.set` merges, and `loadPrefs` fills the rest from
     * `DEFAULT_PREFS`, so a test states only the preferences it cares about.
     */
    __fpsSetPrefsForTest: (prefs: Partial<Prefs>) => chrome.storage.sync.set(prefs),
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

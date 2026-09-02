import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))
/**
 * The e2e build, not `dist/`. It differs from the shipped extension in exactly
 * two ways, both of which are forced by the harness rather than chosen:
 *
 *  - it carries the `__fps*ForTest` hooks (dead-code-eliminated from `dist/`);
 *  - it holds a host permission for the fixture server, because `activeTab` is
 *    granted only by a real click on the toolbar button and neither Playwright
 *    nor the DevTools protocol can synthesise one.
 *
 * Everything under test -- the capture loop, the content script, the offscreen
 * document, the stitcher, the sinks -- is byte-identical to the shipped build.
 */
export const EXTENSION_PATH = path.resolve(here, '../../dist-e2e')
export const BASE_URL = 'http://localhost:5199'

export interface ExtensionHarness {
  context: BrowserContext
  /** Where `chrome.downloads` writes, so delivered files can be read back. */
  downloadDir: string
  close: () => Promise<void>
}

export interface LaunchOptions {
  headed?: boolean
  /** Passed to Chrome as `--force-device-scale-factor`, i.e. a real DPR. */
  deviceScaleFactor?: number
  windowWidth?: number
  windowHeight?: number
}

/**
 * Launches a real Chromium with the built extension loaded.
 *
 * Two choices here are load-bearing:
 *
 *  - `viewport: null`. Playwright's default viewport is a CDP metrics
 *    override, which changes what the page reports for `innerHeight` without
 *    changing the surface `captureVisibleTab` actually grabs. Under an
 *    override the planner and the screenshots disagree about the frame height
 *    and every assertion here becomes meaningless. The window is sized with
 *    `--window-size` instead, so page and capture see the same pixels.
 *  - the download directory is written into the profile's `Preferences` before
 *    launch. `chrome.downloads` ignores Playwright's `downloadsPath` (that
 *    only covers downloads Playwright itself intercepts), and without this the
 *    suite would scatter PNGs through the developer's real Downloads folder
 *    and have no way to read them back.
 */
export async function launchExtension(options: LaunchOptions = {}): Promise<ExtensionHarness> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'fps-profile-'))
  const downloadDir = await mkdtemp(path.join(tmpdir(), 'fps-downloads-'))

  await mkdir(path.join(userDataDir, 'Default'), { recursive: true })
  await writeFile(
    path.join(userDataDir, 'Default', 'Preferences'),
    JSON.stringify({
      download: { default_directory: downloadDir, prompt_for_download: false },
      savefile: { default_directory: downloadDir },
    }),
  )

  const width = options.windowWidth ?? 1280
  const height = options.windowHeight ?? 900

  const context = await chromium.launchPersistentContext(userDataDir, {
    // The full Chromium binary, not `headless_shell`: extensions do not load
    // in the shell build. `channel: 'chromium'` selects new headless mode,
    // which does support them.
    channel: 'chromium',
    headless: !options.headed,
    viewport: null,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      `--window-size=${width},${height}`,
      // Without a pinned colour profile the captured PNG comes back through
      // the display's ICC transform, so a flat #ff0080 header is no longer
      // exactly #ff0080 and exact-colour assertions become unreliable.
      '--force-color-profile=srgb',
      '--no-first-run',
      '--no-default-browser-check',
      ...(options.deviceScaleFactor
        ? [`--force-device-scale-factor=${options.deviceScaleFactor}`]
        : []),
    ],
  })

  // Undo Playwright's own download interception.
  //
  // Playwright sets CDP `Browser.setDownloadBehavior` to `allowAndName` for
  // every context it creates, which redirects *all* downloads -- including
  // ones an extension starts through `chrome.downloads` -- into its artifacts
  // folder under a GUID name, discarding both the profile's download directory
  // and the filename the extension asked for. The public API cannot turn that
  // off: `acceptDownloads: false` means `deny`, which cancels downloads
  // outright. `behavior: 'default'` hands naming and placement back to Chrome,
  // which is what makes the `download.default_directory` written above take
  // effect and what lets this suite assert on the real
  // `full-page-shot/<host>-<stamp>.png` the extension requested.
  //
  // The session is deliberately not detached: the override lives for as long
  // as the session does. None of this was noticed before because, until the
  // download sink moved into the service worker, no capture ever downloaded
  // anything at all.
  const cdpTarget = context.pages()[0] ?? (await context.newPage())
  const cdp = await context.newCDPSession(cdpTarget)
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' })

  // Both, at launch, for the fixture origin. `clipboard-write` is what the
  // content script's `navigator.clipboard.write()` needs, and `clipboard-read`
  // is what lets a test read the image back out again -- an assertion that the
  // capture reached the system clipboard, not merely that no error was thrown.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL })

  return {
    context,
    downloadDir,
    close: () => context.close(),
  }
}

/**
 * The extension's service worker, waited for rather than assumed. MV3 workers
 * start lazily, so on a cold profile `serviceWorkers()` is briefly empty.
 */
export async function serviceWorker(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers()[0]
  if (existing) return existing
  return await context.waitForEvent('serviceworker')
}

/** Opens a fixture and makes it the active tab, which the capture requires. */
export async function openFixture(context: BrowserContext, file: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`${BASE_URL}/${file}`)
  await page.waitForLoadState('load')
  await page.bringToFront()
  return page
}

export interface PageFacts {
  viewportWidth: number
  viewportHeight: number
  scrollHeight: number
  devicePixelRatio: number
}

/**
 * The page facts every geometric assertion in this suite is derived from.
 *
 * The viewport is read from `visualViewport`, with the same fallback the
 * product uses, because that is the measurement the planner works from. It is
 * deliberately not `innerWidth`/`innerHeight`: Chrome rounds those to integers
 * (814 for a real 813.6), and a test that recomputed the expected frame height
 * from the rounded number would agree with a planner fed the rounded number
 * and be blind to precisely the defect `fractional-dpi.spec.ts` exists to
 * catch. `viewportWidth`/`viewportHeight` may therefore be fractional.
 */
export function readPageFacts(page: Page): Promise<PageFacts> {
  return page.evaluate(() => ({
    viewportWidth: window.visualViewport?.width ?? window.innerWidth,
    viewportHeight: window.visualViewport?.height ?? window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
    devicePixelRatio: window.devicePixelRatio,
  }))
}

export interface CaptureProbe {
  badge: string
  frames: number
  elapsedMs: number
  /** How many times `chrome.downloads.download` was actually called. */
  downloadRequests: number
  offscreenClosed: boolean
  /** The image handed back for the clipboard, as a data URL. Always PNG. */
  dataUrl: string | null
  clipboardDataUrl: string | null
  /** The image handed to the download sink, in the preferred format. */
  downloadDataUrl: string | null
  /** The `type` of every message the worker sent to the page, in order. */
  contentMessages: string[]
  /** Whether the content script (an `executeScript` with `files`) was injected. */
  contentScriptInjected: boolean
  error: string | null
}

/** Mirrors `CaptureMode` in `src/shared/prefs.ts`. */
export type CaptureMode = 'full' | 'viewport'

/** Mirrors the writable half of `Prefs` in `src/shared/prefs.ts`. */
export interface PrefsPatch {
  toClipboard?: boolean
  toDownload?: boolean
  captureMode?: CaptureMode
  scale?: 1 | 2
  downloadFormat?: 'png' | 'jpeg' | 'webp'
}

/**
 * Runs the same code path a real toolbar click runs, all the way through the
 * sinks the user's stored preferences select.
 *
 * There is no `mode` any more. It used to divert the final `finishCapture` to
 * a test-only message so the suite could see the stitched image at all, since
 * neither sink worked. `finishCapture` now returns that image in production,
 * so every capture reports its pixels and what to deliver is decided purely by
 * `setPrefs` -- the same switch a user has.
 */
export async function runCapture(
  context: BrowserContext,
  page: Page,
  mode?: CaptureMode,
): Promise<CaptureProbe> {
  const worker = await serviceWorker(context)
  return (await worker.evaluate(
    async ({ url, requestedMode }) =>
      await (
        globalThis as unknown as {
          __fpsCaptureForTest: (u: string, m?: CaptureMode) => Promise<CaptureProbe>
        }
      ).__fpsCaptureForTest(url, requestedMode),
    { url: page.url(), requestedMode: mode },
  )) as CaptureProbe
}

/** Decodes a `data:image/png;base64,...` capture result into raw bytes. */
export function dataUrlToBuffer(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:image/png;base64,') || comma < 0) {
    throw new Error(`not a base64 PNG data URL: ${dataUrl.slice(0, 40)}`)
  }
  return Buffer.from(dataUrl.slice(comma + 1), 'base64')
}

/** The mime type declared by a `data:` URL, e.g. `image/jpeg`. */
export function dataUrlMime(dataUrl: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl)
  if (!match?.[1]) throw new Error(`not a data URL: ${dataUrl.slice(0, 40)}`)
  return match[1]
}

export async function setPrefs(context: BrowserContext, prefs: PrefsPatch): Promise<void> {
  const worker = await serviceWorker(context)
  await worker.evaluate(
    async (value) =>
      await (
        globalThis as unknown as {
          __fpsSetPrefsForTest: (p: typeof value) => Promise<void>
        }
      ).__fpsSetPrefsForTest(value),
    prefs,
  )
}

/** One raw `captureVisibleTab` frame, undecorated by the stitcher. */
export async function grabRawFrame(context: BrowserContext, page: Page): Promise<string> {
  const worker = await serviceWorker(context)
  return (await worker.evaluate(
    async (url) =>
      await (
        globalThis as unknown as { __fpsGrabFrameForTest: (u: string) => Promise<string> }
      ).__fpsGrabFrameForTest(url),
    page.url(),
  )) as string
}

export interface DeliveredFile {
  filePath: string
  bytes: Buffer
}

/**
 * Reads back the PNG the capture actually delivered.
 *
 * `seen` is the set of files that already existed, so the caller identifies
 * *its* download by name rather than by mtime -- with several captures a
 * second apart, an mtime heuristic picks the wrong file often enough to make
 * the suite lie.
 *
 * `immediate` makes this a single pass with no polling. That is what turns
 * "the file is already complete the moment the capture reports success" into a
 * real assertion instead of something a retry loop papers over: the download
 * sink does not resolve until Chrome reports a terminal state, so by the time
 * the badge is set the bytes are on disk.
 */
export async function newDownload(
  downloadDir: string,
  seen: Set<string>,
  options: { immediate?: boolean; extension?: string } = {},
): Promise<DeliveredFile> {
  const dir = path.join(downloadDir, 'full-page-shot')
  const extension = options.extension ?? '.png'
  const deadline = Date.now() + (options.immediate ? 0 : 15_000)
  let lastSeen = 'nothing'
  for (;;) {
    const names = await readdir(dir).catch(() => [] as string[])
    const fresh = names.filter((name) => name.endsWith(extension) && !seen.has(name))
    const partial = names.filter((name) => name.endsWith('.crdownload'))
    const name = fresh[0]
    if (name && partial.length === 0) {
      const filePath = path.join(dir, name)
      const bytes = await readFile(filePath)
      // A PNG whose last chunk is not IEND is one Chrome has not finished
      // writing -- exactly the truncation a premature offscreen close causes.
      // Only PNG carries that marker, so a lossy download is judged complete
      // by the absence of a `.crdownload` sibling instead.
      if (extension !== '.png' || bytes.subarray(-8, -4).toString('latin1') === 'IEND') {
        seen.add(name)
        return { filePath, bytes }
      }
      lastSeen = `${name}: ${String(bytes.length)} bytes, no IEND (truncated)`
    } else {
      lastSeen = `fresh=[${fresh.join(', ')}] partial=[${partial.join(', ')}]`
    }
    if (Date.now() >= deadline) throw new Error(`no complete download appeared: ${lastSeen}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** The download filenames that already exist, so a later call can spot new ones. */
export async function listDownloads(downloadDir: string): Promise<Set<string>> {
  const names = await readdir(path.join(downloadDir, 'full-page-shot')).catch(() => [] as string[])
  return new Set(names)
}

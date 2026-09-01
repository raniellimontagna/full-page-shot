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

export function readPageFacts(page: Page): Promise<PageFacts> {
  return page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
    devicePixelRatio: window.devicePixelRatio,
  }))
}

export interface CaptureProbe {
  badge: string
  frames: number
  elapsedMs: number
  downloadPending: boolean | null
  offscreenClosed: boolean
  /** The stitched PNG as a data URL, when captured with `mode: 'export'`. */
  dataUrl: string | null
  error: string | null
}

/**
 * Runs the same code path a real toolbar click runs.
 *
 * `mode: 'export'` diverts only the final `finishCapture` message, so the
 * stitched image comes back to the test instead of going to the sinks; every
 * earlier step is production code. `mode: 'deliver'` runs the sinks for real.
 */
export async function runCapture(
  context: BrowserContext,
  page: Page,
  mode: 'deliver' | 'export' = 'export',
): Promise<CaptureProbe> {
  const worker = await serviceWorker(context)
  return (await worker.evaluate(
    async ({ url, how }) =>
      await (
        globalThis as unknown as {
          __fpsCaptureForTest: (u: string, m: string) => Promise<CaptureProbe>
        }
      ).__fpsCaptureForTest(url, how),
    { url: page.url(), how: mode },
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

export async function setPrefs(
  context: BrowserContext,
  prefs: { toClipboard: boolean; toDownload: boolean },
): Promise<void> {
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
 * "the file is complete the moment `finishCapture` reports `downloadPending:
 * false`" into a real assertion instead of something a retry loop papers over.
 */
export async function newDownload(
  downloadDir: string,
  seen: Set<string>,
  options: { immediate?: boolean } = {},
): Promise<DeliveredFile> {
  const dir = path.join(downloadDir, 'full-page-shot')
  const deadline = Date.now() + (options.immediate ? 0 : 15_000)
  let lastSeen = 'nothing'
  for (;;) {
    const names = await readdir(dir).catch(() => [] as string[])
    const fresh = names.filter((name) => name.endsWith('.png') && !seen.has(name))
    const partial = names.filter((name) => name.endsWith('.crdownload'))
    const name = fresh[0]
    if (name && partial.length === 0) {
      const filePath = path.join(dir, name)
      const bytes = await readFile(filePath)
      // A PNG whose last chunk is not IEND is one Chrome has not finished
      // writing -- exactly the truncation a premature offscreen close causes.
      if (bytes.subarray(-8, -4).toString('latin1') === 'IEND') {
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

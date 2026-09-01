import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import {
  launchExtension,
  listDownloads,
  newDownload,
  openFixture,
  readPageFacts,
  runCapture,
  setPrefs,
  type ExtensionHarness,
} from './helpers/extension'
import { pngSize } from './helpers/image'

/**
 * ============================================================================
 * READ THIS BEFORE TOUCHING A `test.fail()` IN THIS FILE.
 *
 * Every capture here runs in `deliver` mode, so the real sinks in
 * `src/offscreen/sinks.ts` run. Three of the four tests are marked
 * `test.fail()` because they are standing reproductions of two defects this
 * suite found on its first run against a real browser:
 *
 *  1. `chrome.downloads` is `undefined` inside the offscreen document, so
 *     `downloadBlob` throws `TypeError: Cannot read properties of undefined
 *     (reading 'download')` before a byte is written. Offscreen documents get
 *     `chrome.runtime` and little else; privileged APIs have to be called from
 *     the service worker. The service worker's own `chrome.downloads.search`
 *     works fine -- it is only the offscreen half that is dead.
 *
 *  2. `navigator.clipboard.write()` throws `NotAllowedError: Document is not
 *     focused` inside the offscreen document. An offscreen document has no
 *     window and can never be focused, and `reasons: [CLIPBOARD]` grants the
 *     API without lifting the focus requirement. Verified against a headed
 *     browser, and against a control: an ordinary page in the same browser
 *     reports `document.hasFocus() === true` and writes the clipboard fine.
 *
 * `test.fail()` does not weaken the assertions -- they are written exactly as
 * they should be once the sinks work. Playwright reports an *unexpected pass*
 * as a failure, so the moment either defect is fixed this file goes red and
 * whoever fixed it removes the marker. Do not delete these tests to get green;
 * deleting them is how the defect ships.
 * ============================================================================
 */

const BOTTOM_BAND_FIXTURE = 'non-multiple.html'

let harness: ExtensionHarness
let context: BrowserContext

test.beforeEach(async () => {
  harness = await launchExtension()
  context = harness.context
})

test.afterEach(async () => {
  await harness.close()
})

async function capturePage(): Promise<{ page: Page; probe: Awaited<ReturnType<typeof runCapture>> }> {
  const page = await openFixture(context, BOTTOM_BAND_FIXTURE)
  const probe = await runCapture(context, page, 'deliver')
  return { page, probe }
}

test('downloadPending is false when the request did not ask for a download', async () => {
  await setPrefs(context, { toClipboard: false, toDownload: false })
  const before = await listDownloads(harness.downloadDir)
  const { probe } = await capturePage()

  expect(probe.error).toBeNull()
  expect(probe.badge).toBe('✓')
  // The field only ever means "a download is still writing". With no download
  // requested there is nothing to wait for, so it must be false -- if it could
  // be true here the service worker would keep the offscreen document open
  // forever waiting on a download that was never started.
  expect(probe.downloadPending).toBe(false)
  // And the offscreen document is closed immediately, because nothing is
  // reading a blob URL out of it.
  expect(probe.offscreenClosed).toBe(true)
  expect(await listDownloads(harness.downloadDir)).toEqual(before)
})

test('a requested download is complete on disk before finishCapture resolves', async () => {
  // Scoped inside the body on purpose: a file-scope `test.fail()` applies to
  // every test in the file, including ones declared above it.
  test.fail(true, 'chrome.downloads is undefined in the offscreen document')
  await setPrefs(context, { toClipboard: false, toDownload: true })
  const seen = await listDownloads(harness.downloadDir)
  const { page, probe } = await capturePage()
  const facts = await readPageFacts(page)

  expect(probe.error).toBeNull()
  expect(probe.badge).toBe('✓')
  // `false` is the offscreen document saying the download reached a terminal
  // state before it replied -- the whole point of `DownloadOutcome`.
  expect(probe.downloadPending).toBe(false)
  // And on that basis the service worker closed the document, which tears down
  // the blob URL Chrome was reading the PNG out of.
  expect(probe.offscreenClosed).toBe(true)

  // `immediate: true` -- a single pass, no polling. If closing the offscreen
  // document truncated the write, or if `downloadPending: false` was reported
  // before the bytes landed, the file is absent or has no IEND chunk right
  // now, and no retry loop hides it.
  const delivered = await newDownload(harness.downloadDir, seen, { immediate: true })
  const steps = Math.ceil(facts.scrollHeight / facts.viewportHeight)
  const frameHeight = Math.round(facts.viewportHeight * facts.devicePixelRatio)
  expect(pngSize(delivered.bytes)).toEqual({
    width: Math.round(facts.viewportWidth * facts.devicePixelRatio),
    height: Math.min(Math.round(facts.scrollHeight * facts.devicePixelRatio), steps * frameHeight),
  })
})

test('the clipboard holds the capture after a real capture', async () => {
  test.fail(true, 'navigator.clipboard.write() cannot work from an offscreen document')
  await setPrefs(context, { toClipboard: true, toDownload: false })
  const { page, probe } = await capturePage()

  expect(probe.error).toBeNull()
  expect(probe.badge).toBe('✓')

  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'http://localhost:5199',
  })
  const clipboard = await page.evaluate(async () => {
    const items = await navigator.clipboard.read()
    const item = items[0]
    if (!item) return { types: [], bytes: 0 }
    const blob = await item.getType('image/png')
    return { types: item.types.slice(), bytes: blob.size }
  })
  expect(clipboard.types).toContain('image/png')
  expect(clipboard.bytes).toBeGreaterThan(1_000)
})

test('the shipped default preferences deliver a capture', async () => {
  test.fail(true, 'both sinks are broken, so the shipped defaults deliver nothing')
  // The single most user-visible statement in this file: with `DEFAULT_PREFS`
  // (clipboard *and* download both on), does clicking the button produce
  // anything at all? Today it does not -- the clipboard write throws first and
  // takes the download down with it, because `finishCapture` runs the sinks in
  // sequence with no isolation between them.
  const seen = await listDownloads(harness.downloadDir)
  await setPrefs(context, { toClipboard: true, toDownload: true })
  const { probe } = await capturePage()

  expect(probe.error).toBeNull()
  expect(probe.badge).toBe('✓')
  await newDownload(harness.downloadDir, seen)
})

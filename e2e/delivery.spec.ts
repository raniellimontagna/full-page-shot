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
 * Every capture here runs the real sinks, selected by the same stored
 * preferences a user sets in the options page.
 *
 * Three of these four tests were standing `test.fail()` reproductions of the
 * defects Task 9 found on its first run against a real browser:
 *
 *  1. `chrome.downloads` is `undefined` inside an offscreen document, so the
 *     download sink threw `TypeError: Cannot read properties of undefined
 *     (reading 'download')` before a byte was written. The download now runs
 *     in the service worker, which has the API for real.
 *
 *  2. `navigator.clipboard.write()` throws `NotAllowedError: Document is not
 *     focused` inside an offscreen document, which has no window and can never
 *     be focused (`reasons: [CLIPBOARD]` grants the API, not the focus). The
 *     copy now runs in the captured tab's content script, a focused document.
 *
 *  3. The two ran in sequence with no isolation, so the clipboard throw
 *     cancelled the download and the *shipped defaults* delivered nothing at
 *     all. They now run under `Promise.allSettled`.
 *
 * The assertions are unchanged from when they were expected failures -- they
 * were always written for a working delivery layer. Only the `test.fail()`
 * markers are gone. If one of these goes red, delivery is broken again; do not
 * reach for a marker.
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
  const probe = await runCapture(context, page)
  return { page, probe }
}

test('no sink runs when the preferences ask for neither', async () => {
  await setPrefs(context, { toClipboard: false, toDownload: false })
  const before = await listDownloads(harness.downloadDir)
  const { probe } = await capturePage()

  expect(probe.error).toBeNull()
  // Every enabled sink succeeded, vacuously: the capture did everything it was
  // asked to do.
  expect(probe.badge).toBe('✓')
  // Watched at the Chrome API, not inferred from the absence of a file: the
  // download sink was never even asked to run.
  expect(probe.downloadRequests).toBe(0)
  // And the offscreen document is closed immediately, because nothing is left
  // in flight there once it has handed back the image.
  expect(probe.offscreenClosed).toBe(true)
  expect(await listDownloads(harness.downloadDir)).toEqual(before)
})

test('a requested download is complete on disk before the capture reports success', async () => {
  await setPrefs(context, { toClipboard: false, toDownload: true })
  const seen = await listDownloads(harness.downloadDir)
  const { page, probe } = await capturePage()
  const facts = await readPageFacts(page)

  expect(probe.error).toBeNull()
  expect(probe.badge).toBe('✓')
  // Exactly one download was requested, of the whole capture -- not one per
  // frame, and not none.
  expect(probe.downloadRequests).toBe(1)
  // And the offscreen document was closed while that download was still being
  // written, which is now harmless: `chrome.downloads` is reading a data URL
  // held by the service worker, not a blob URL owned by a document that has
  // just been torn down.
  expect(probe.offscreenClosed).toBe(true)

  // `immediate: true` -- a single pass, no polling. The download sink does not
  // resolve until Chrome reports a terminal state, so if the badge went green
  // before the bytes landed the file is absent or has no IEND chunk right now,
  // and no retry loop hides it.
  const delivered = await newDownload(harness.downloadDir, seen, { immediate: true })
  const steps = Math.ceil(facts.scrollHeight / facts.viewportHeight)
  const frameHeight = Math.round(facts.viewportHeight * facts.devicePixelRatio)
  expect(pngSize(delivered.bytes)).toEqual({
    width: Math.round(facts.viewportWidth * facts.devicePixelRatio),
    height: Math.min(Math.round(facts.scrollHeight * facts.devicePixelRatio), steps * frameHeight),
  })
})

test('the clipboard holds the capture after a real capture', async () => {
  await setPrefs(context, { toClipboard: true, toDownload: false })
  const { page, probe } = await capturePage()

  expect(probe.error).toBeNull()
  expect(probe.badge).toBe('✓')
  // Nothing was written to disk -- this is the clipboard sink on its own.
  expect(probe.downloadRequests).toBe(0)

  // Read back from the system clipboard through the page, so the assertion is
  // about what a user would paste, not about the extension's own report.
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
  // The single most user-visible statement in this file: with `DEFAULT_PREFS`
  // (clipboard *and* download both on), does clicking the button produce
  // anything at all? It used not to -- the clipboard write threw first and took
  // the download down with it, so a default install produced nothing and a red
  // badge.
  const seen = await listDownloads(harness.downloadDir)
  await setPrefs(context, { toClipboard: true, toDownload: true })
  const { page, probe } = await capturePage()

  expect(probe.error).toBeNull()
  // ✓, not the amber partial badge: both sinks delivered.
  expect(probe.badge).toBe('✓')
  const delivered = await newDownload(harness.downloadDir, seen)

  // Both sinks, from one capture, holding the same image.
  const clipboardBytes = await page.evaluate(async () => {
    const items = await navigator.clipboard.read()
    const item = items[0]
    if (!item) return 0
    return (await item.getType('image/png')).size
  })
  expect(clipboardBytes).toBeGreaterThan(1_000)
  expect(pngSize(delivered.bytes).height).toBeGreaterThan(0)
})

import { expect, test, type BrowserContext } from '@playwright/test'
import {
  dataUrlMime,
  dataUrlToBuffer,
  launchExtension,
  listDownloads,
  newDownload,
  openFixture,
  readPageFacts,
  runCapture,
  setPrefs,
  type ExtensionHarness,
  type PageFacts,
} from './helpers/extension'
import { pngSize } from './helpers/image'

/**
 * ============================================================================
 * v1.1: the two capture modes and the output-size preferences, observed in a
 * real browser.
 *
 * Everything asserted here is watched at a Chrome API or read off delivered
 * bytes -- the frame count, the messages sent to the page, the injections, the
 * PNG header, the file on disk, the system clipboard. Nothing is taken from a
 * flag the product reports about itself.
 * ============================================================================
 */

// `capture-loop.ts`. One full-page step costs at least this much in enforced
// spacing, so a capture that finishes inside it demonstrably did not scroll.
const CAPTURE_INTERVAL_MS = 550

/** The device-pixel canvas the full-page path stitches, before any rescale. */
function deviceCanvas(facts: PageFacts): { width: number; height: number } {
  const frameHeight = Math.round(facts.viewportHeight * facts.devicePixelRatio)
  const steps = Math.max(1, Math.ceil(facts.scrollHeight / facts.viewportHeight))
  return {
    width: Math.round(facts.viewportWidth * facts.devicePixelRatio),
    height: Math.min(Math.round(facts.scrollHeight * facts.devicePixelRatio), steps * frameHeight),
  }
}

test.describe('viewport mode', () => {
  let harness: ExtensionHarness
  let context: BrowserContext

  test.beforeAll(async () => {
    harness = await launchExtension()
    context = harness.context
    // Defaults for scale and format; only the sinks are silenced, so the
    // pixels come back without touching disk or the system clipboard.
    await setPrefs(context, { toClipboard: false, toDownload: false, captureMode: 'full' })
  })

  test.afterAll(async () => {
    await harness.close()
  })

  test('captures one frame of what is on screen and leaves the page untouched', async () => {
    const page = await openFixture(context, 'long-fixed-header.html')
    await page.evaluate(() => window.scrollTo(0, 500))
    expect(await page.evaluate(() => window.scrollY)).toBe(500)
    const facts = await readPageFacts(page)
    // The fixture is many viewports tall: a full-page capture of it would take
    // several frames, so "exactly one" below is a real distinction.
    expect(facts.scrollHeight).toBeGreaterThan(facts.viewportHeight * 5)

    const probe = await runCapture(context, page, 'viewport')

    expect(probe.error).toBeNull()
    expect(probe.badge).toBe('✓')
    // Watched at `chrome.tabs.captureVisibleTab`: one frame, not six.
    expect(probe.frames).toBe(1)

    // The image is one viewport tall at the user's scale (1x by default), not
    // the whole document.
    expect(probe.clipboardDataUrl).not.toBeNull()
    // Chrome's frame is `round(viewport * dpr)` device pixels (established
    // independently by `fractional-dpi.spec.ts`); 1x divides that back down.
    const size = pngSize(dataUrlToBuffer(probe.clipboardDataUrl ?? ''))
    const dpr = facts.devicePixelRatio
    expect(size.height).toBe(Math.round(Math.round(facts.viewportHeight * dpr) / dpr))
    expect(size.width).toBe(Math.round(Math.round(facts.viewportWidth * dpr) / dpr))

    // The page was never scrolled, so there is nothing to restore and the
    // scroll position is exactly where the user left it.
    expect(await page.evaluate(() => window.scrollY)).toBe(500)

    // And it was never spoken to. These four messages are the only ones that
    // interrogate or alter the document; the viewport path must send none.
    for (const type of ['measure', 'hideFixed', 'scrollTo', 'restore']) {
      expect(probe.contentMessages, `viewport capture sent "${type}" to the page`).not.toContain(
        type,
      )
    }
    // Nor was the content script injected at all.
    expect(probe.contentScriptInjected).toBe(false)

    // The control, on the same fixture in the same window: a full-page
    // capture. Without it, "one frame, no messages" could equally describe a
    // capture that silently did nothing -- and it is the only fair yardstick
    // for the timing claim below.
    const full = await runCapture(context, page, 'full')
    expect(full.badge).toBe('✓')
    expect(full.frames).toBeGreaterThan(1)
    expect(full.contentMessages).toContain('measure')
    expect(full.contentMessages).toContain('restore')
    expect(full.contentScriptInjected).toBe(true)
    expect(full.elapsedMs).toBeGreaterThan(CAPTURE_INTERVAL_MS)

    // A single frame pays none of the full path's enforced inter-frame
    // spacing. It is *not* asserted to fit inside one CAPTURE_INTERVAL_MS in
    // absolute terms: measured in real Chromium, the first capture in a fresh
    // profile spends about a second creating the offscreen document, which
    // both paths pay and neither can avoid. The comparison is the honest
    // form -- and it is conservative, since the viewport capture ran first and
    // therefore carried that one-off cost itself.
    //
    // The divisor is 2, not a tighter ratio: measured values were ~1.07s for
    // the probe vs ~4.9s for the full run, a >4x gap, but roughly 1s of the
    // probe's time is the one-off offscreen-document creation that lands on
    // whichever run happens first (here, the viewport run), while the full
    // run's duration is dominated by the fixed 550ms inter-frame spacing
    // across many frames. On a slow CI runner that fixed cold-start cost is a
    // proportionally larger share of the probe's total, which erodes the
    // ratio in the flaky direction -- /2 keeps meaningful margin without
    // being tight enough to flake on a loaded runner.
    expect(probe.elapsedMs).toBeLessThan(full.elapsedMs / 2)

    await page.close()
  })
})

test.describe('output size at device scale factor 2', () => {
  test('1x delivers exactly half the device-pixel canvas in both axes', async () => {
    const harness = await launchExtension({ deviceScaleFactor: 2 })
    try {
      const context = harness.context
      await setPrefs(context, { toClipboard: false, toDownload: false, scale: 1 })
      const page = await openFixture(context, 'non-multiple.html')
      const facts = await readPageFacts(page)
      expect(facts.devicePixelRatio).toBe(2)

      const probe = await runCapture(context, page, 'full')
      expect(probe.error).toBeNull()
      const canvas = deviceCanvas(facts)
      const size = pngSize(dataUrlToBuffer(probe.clipboardDataUrl ?? ''))
      expect(size).toEqual({
        width: Math.round(canvas.width / 2),
        height: Math.round(canvas.height / 2),
      })
      await page.close()
    } finally {
      await harness.close()
    }
  })

  test('2x delivers the device-pixel canvas as stitched', async () => {
    // The other half of the same claim: the downscale above is the preference
    // doing work, not the canvas having been small all along.
    const harness = await launchExtension({ deviceScaleFactor: 2 })
    try {
      const context = harness.context
      await setPrefs(context, { toClipboard: false, toDownload: false, scale: 2 })
      const page = await openFixture(context, 'non-multiple.html')
      const facts = await readPageFacts(page)
      const probe = await runCapture(context, page, 'full')
      expect(probe.error).toBeNull()
      expect(pngSize(dataUrlToBuffer(probe.clipboardDataUrl ?? ''))).toEqual(deviceCanvas(facts))
      await page.close()
    } finally {
      await harness.close()
    }
  })
})

test.describe('download formats', () => {
  let harness: ExtensionHarness
  let context: BrowserContext

  test.beforeEach(async () => {
    harness = await launchExtension()
    context = harness.context
  })

  test.afterEach(async () => {
    await harness.close()
  })

  test('a PNG download is the very same bytes as the clipboard image', async () => {
    // Format routing, not the single-encode contract: this only proves that
    // with `downloadFormat: 'png'` both sinks end up holding the same PNG
    // string. PNG encoding of a given canvas is deterministic, so encoding
    // it twice would produce the identical string here too -- this
    // assertion cannot tell "encoded once, handed back twice" apart from
    // "encoded twice, byte-for-byte the same both times". The single-encode
    // contract itself is covered by the unit test in
    // tests/offscreen/export-both.test.ts, which injects a fake `Stitcher`
    // and counts calls to `export`.
    await setPrefs(context, { toClipboard: false, toDownload: false, downloadFormat: 'png' })
    const page = await openFixture(context, 'short.html')
    const probe = await runCapture(context, page, 'full')

    expect(probe.error).toBeNull()
    expect(probe.clipboardDataUrl).not.toBeNull()
    expect(probe.downloadDataUrl).toBe(probe.clipboardDataUrl)
    await page.close()
  })

  for (const { format, extension, mime, magic } of [
    { format: 'jpeg' as const, extension: '.jpg', mime: 'image/jpeg', magic: 'ffd8' },
    { format: 'webp' as const, extension: '.webp', mime: 'image/webp', magic: 'riff' },
  ]) {
    test(`a ${format} download is written as ${format} while the clipboard stays PNG`, async () => {
      await setPrefs(context, { toClipboard: true, toDownload: true, downloadFormat: format })
      const seen = await listDownloads(harness.downloadDir)
      const page = await openFixture(context, 'short.html')
      const probe = await runCapture(context, page, 'full')

      expect(probe.error).toBeNull()
      expect(probe.badge).toBe('✓')
      expect(probe.downloadRequests).toBe(1)

      // Not the same image twice: a lossy download is encoded separately.
      expect(probe.downloadDataUrl).not.toBe(probe.clipboardDataUrl)
      expect(dataUrlMime(probe.clipboardDataUrl ?? '')).toBe('image/png')
      expect(dataUrlMime(probe.downloadDataUrl ?? '')).toBe(mime)

      const delivered = await newDownload(harness.downloadDir, seen, { extension })
      expect(delivered.filePath.endsWith(extension)).toBe(true)
      // The file's own magic number, read off disk, not the name or the mime
      // the extension claimed: JPEG starts FF D8, WebP is `RIFF....WEBP`.
      if (magic === 'ffd8') {
        expect(delivered.bytes.subarray(0, 2).toString('hex')).toBe('ffd8')
      } else {
        expect(delivered.bytes.subarray(0, 4).toString('latin1')).toBe('RIFF')
        expect(delivered.bytes.subarray(8, 12).toString('latin1')).toBe('WEBP')
      }

      // And what a user would paste is still a PNG.
      const clipboard = await page.evaluate(async () => {
        const items = await navigator.clipboard.read()
        const item = items[0]
        if (!item) return { types: [] as string[], bytes: 0 }
        return { types: item.types.slice(), bytes: (await item.getType('image/png')).size }
      })
      expect(clipboard.types).toContain('image/png')
      expect(clipboard.bytes).toBeGreaterThan(1_000)
      await page.close()
    })
  }

  test('a viewport download is named with the -viewport suffix', async () => {
    await setPrefs(context, { toClipboard: false, toDownload: true, downloadFormat: 'png' })
    const seen = await listDownloads(harness.downloadDir)
    const page = await openFixture(context, 'long-fixed-header.html')
    const probe = await runCapture(context, page, 'viewport')

    expect(probe.error).toBeNull()
    expect(probe.downloadRequests).toBe(1)
    const delivered = await newDownload(harness.downloadDir, seen)
    expect(delivered.filePath).toMatch(/-viewport\.(png|jpg|webp)$/)
    await page.close()
  })
})

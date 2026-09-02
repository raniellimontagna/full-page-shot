import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import {
  dataUrlToBuffer,
  launchExtension,
  openFixture,
  readPageFacts,
  runCapture,
  setPrefs,
  type ExtensionHarness,
  type PageFacts,
} from './helpers/extension'
import { analyzePng, decoderPage, pngSize, type ImageReport } from './helpers/image'

/**
 * The colours the fixtures paint. Flat, unique, and never produced by a
 * gradient, so an exact-match scan over the whole image means what it says.
 */
const HEADER = '#ff0080'
const FOOTER = '#00ffff'
const BOTTOM_BAND = '#ff00ff'
const LAZY_IMAGE = '#00dc5a'
const LAZY_OBSERVED = '#ffcc00'
const HEADER_HEIGHT_CSS = 60

let harness: ExtensionHarness
let context: BrowserContext
let decoder: Page

test.beforeAll(async () => {
  harness = await launchExtension()
  context = harness.context
  decoder = await decoderPage(context)
  // Both sinks off. Every capture still reports its stitched image -- that is
  // part of the shipped protocol now, not a test hook -- so these tests get
  // the pixels without writing a file or touching the system clipboard on
  // every one of them. Delivery has its own file (`delivery.spec.ts`); what
  // this file asserts is everything before it: measure, plan, scroll, hide
  // fixed elements, capture, stitch, restore.
  await setPrefs(context, { toClipboard: false, toDownload: false })
})

test.afterAll(async () => {
  await harness.close()
})

/** The canvas height `planCapture` should produce for these page facts. */
function expectedCanvasHeight(facts: PageFacts): number {
  const frameHeight = Math.round(facts.viewportHeight * facts.devicePixelRatio)
  const steps = Math.max(1, Math.ceil(facts.scrollHeight / facts.viewportHeight))
  return Math.min(Math.round(facts.scrollHeight * facts.devicePixelRatio), steps * frameHeight)
}

async function captureAndDecode(
  page: Page,
  colors: string[],
): Promise<{ report: ImageReport; facts: PageFacts; frames: number; badge: string }> {
  const facts = await readPageFacts(page)
  const probe = await runCapture(context, page)
  expect(probe.error, 'capture logged an error').toBeNull()
  expect(probe.badge).toBe('✓')
  expect(probe.dataUrl, 'no stitched image came back').not.toBeNull()
  const bytes = dataUrlToBuffer(probe.dataUrl ?? '')
  const report = await analyzePng(decoder, bytes, { colors })
  // The PNG header and the decoder must agree, or one of them is lying.
  expect(pngSize(bytes)).toEqual({ width: report.width, height: report.height })
  return { report, facts, frames: probe.frames, badge: probe.badge }
}

test('a page shorter than the viewport captures in one frame at the right height', async () => {
  const page = await openFixture(context, 'short.html')
  const { report, facts, frames } = await captureAndDecode(page, [])

  // The page is shorter than the viewport, so documentElement.scrollHeight is
  // the viewport height and the whole page is one frame.
  expect(facts.scrollHeight).toBe(facts.viewportHeight)
  expect(frames).toBe(1)
  expect(report.height).toBe(Math.round(facts.viewportHeight * facts.devicePixelRatio))
  expect(report.width).toBe(Math.round(facts.viewportWidth * facts.devicePixelRatio))
  await page.close()
})

test('a long page captures its full height', async () => {
  const page = await openFixture(context, 'long-fixed-header.html')
  const { report, facts, frames } = await captureAndDecode(page, [FOOTER])

  expect(facts.scrollHeight).toBeGreaterThan(facts.viewportHeight * 5)
  expect(frames).toBe(Math.ceil(facts.scrollHeight / facts.viewportHeight))
  expect(report.height).toBe(expectedCanvasHeight(facts))
  // Not just "tall enough": the page's last 40 CSS px are cyan, so the real
  // bottom of the document has to be the bottom of the image.
  expect(report.colors[FOOTER]?.maxY).toBe(report.height - 1)
  await page.close()
})

test('a page whose height is not a viewport multiple keeps its bottom edge', async () => {
  const page = await openFixture(context, 'non-multiple.html')
  const { report, facts } = await captureAndDecode(page, [BOTTOM_BAND])

  // The fixture sizes itself to 2 viewports + 137 px, so the final capture
  // step is clamped to the page bottom and its frame overlaps the one before.
  expect(facts.scrollHeight % facts.viewportHeight).not.toBe(0)
  expect(report.height).toBe(expectedCanvasHeight(facts))

  const band = report.colors[BOTTOM_BAND]
  expect(band, 'the magenta bottom band is missing entirely').toBeDefined()
  expect(band?.maxY).toBe(report.height - 1)
  // 40 CSS px tall, allowing one row of edge blending at the top boundary.
  const bandRows = Math.round(40 * facts.devicePixelRatio)
  expect(band?.minY).toBeGreaterThanOrEqual(report.height - bandRows - 1)
  expect(report.lastRow).toBe(BOTTOM_BAND)
  await page.close()
})

test('lazily-loaded content appears in the stitched image', async () => {
  const page = await openFixture(context, 'lazy.html')
  const { report, facts } = await captureAndDecode(page, [LAZY_IMAGE, LAZY_OBSERVED])

  // Two independent late-arriving things, both three viewports down:
  //  - a `loading="lazy"` <img> fetched over the network on scroll;
  //  - a block an IntersectionObserver paints, whose callback lands after the
  //    paint that follows the scroll -- so only SETTLE_DELAY_MS can catch it.
  // If either is absent, the settle delay in scroll-driver.ts is too short.
  const image = report.colors[LAZY_IMAGE]
  const observed = report.colors[LAZY_OBSERVED]
  const scale = facts.devicePixelRatio ** 2
  expect(image?.count ?? 0, 'the lazy <img> never made it into the capture').toBeGreaterThan(
    400 * 300 * 0.95 * scale,
  )
  expect(
    observed?.count ?? 0,
    'the IntersectionObserver block never made it into the capture',
  ).toBeGreaterThan(facts.viewportWidth * 200 * 0.9 * scale)
  await page.close()
})

test('the fixed header appears exactly once, at the top', async () => {
  const page = await openFixture(context, 'long-fixed-header.html')
  const { report, facts } = await captureAndDecode(page, [HEADER])

  const header = report.colors[HEADER]
  expect(header, 'the fixed header is missing from the capture').toBeDefined()
  expect(header?.minY).toBe(0)

  // The whole point. A header re-captured at every frame boundary would put
  // this colour at y = k * frameHeight for k >= 1; a header hidden too early
  // would put it nowhere. It must live in the first 60 CSS px and nowhere
  // else, so the bound is checked against the header's own height, not merely
  // against the first frame.
  const headerRows = Math.round(HEADER_HEIGHT_CSS * facts.devicePixelRatio)
  expect(header?.maxY).toBeLessThanOrEqual(headerRows)

  // And it must be a solid bar, not a sliver: a near-full count of header
  // pixels rules out the case where only an anti-aliased edge survives.
  const expectedPixels = Math.round(facts.viewportWidth * facts.devicePixelRatio) * headerRows
  expect(header?.count ?? 0).toBeGreaterThan(expectedPixels * 0.95)

  // The column probe is the same claim read a second way: run 0 is the header
  // and every later run is page content.
  expect(report.column[0]?.color).toBe(HEADER)
  expect(report.column.slice(1).some((run) => run.color === HEADER)).toBe(false)
  await page.close()
})

test('no fully-transparent row anywhere in the stitched PNG', async () => {
  // The fractional-DPI arithmetic in page-metrics.ts and stitch-plan.ts exists
  // to guarantee that every canvas row is painted by some frame. An uncovered
  // row is transparent, because the offscreen canvas starts transparent and
  // nothing ever fills it. This is that guarantee, read off a real image.
  // `fractional-dpi.spec.ts` repeats it at dpr 1.25 and 1.5, where the
  // arithmetic is actually under strain.
  for (const fixture of ['long-fixed-header.html', 'non-multiple.html', 'lazy.html']) {
    const page = await openFixture(context, fixture)
    const { report } = await captureAndDecode(page, [])
    expect(report.fullyTransparentRows, `${fixture} has unpainted rows`).toEqual([])
    expect(report.translucentRows, `${fixture} has partially unpainted rows`).toEqual([])
    await page.close()
  }
})

test('scroll position and the fixed header are restored after a successful capture', async () => {
  const page = await openFixture(context, 'long-fixed-header.html')
  await page.evaluate(() => window.scrollTo(0, 500))
  expect(await page.evaluate(() => window.scrollY)).toBe(500)

  const probe = await runCapture(context, page)
  expect(probe.badge).toBe('✓')

  expect(await page.evaluate(() => window.scrollY)).toBe(500)
  expect(
    await page.evaluate(() => getComputedStyle(document.querySelector('#hdr')!).visibility),
  ).toBe('visible')
  // The marker the content script writes must be gone too, or a later
  // `restore` would have nothing to put back.
  expect(await page.evaluate(() => document.querySelectorAll('[data-fps-prev-visibility]').length)).toBe(0)
  await page.close()
})

test('scroll position is restored after a capture that fails part-way', async () => {
  const page = await openFixture(context, 'long-fixed-header.html')
  await page.evaluate(() => window.scrollTo(0, 500))

  // A real production failure, not an injected one: the user switches tabs
  // mid-capture, `isTabStillActive` goes false, and the loop aborts rather
  // than splicing another page into the screenshot. The page is latched and
  // scrolled at that moment, so only the `finally` can put it back.
  const other = await context.newPage()
  await other.goto('about:blank')
  // Opening a tab focuses it, so the fixture has to be brought back to the
  // front before the capture starts -- otherwise the very first
  // `isTabStillActive` check aborts and nothing is ever latched, which tests
  // the guard but not the restore.
  await page.bringToFront()
  const running = runCapture(context, page)
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  await other.bringToFront()
  const probe = await running

  expect(probe.badge).toBe('✕')
  expect(probe.error).toContain('tab is no longer active')
  expect(probe.frames).toBeGreaterThan(0)
  expect(probe.frames).toBeLessThan(6)

  expect(await page.evaluate(() => window.scrollY)).toBe(500)
  expect(
    await page.evaluate(() => getComputedStyle(document.querySelector('#hdr')!).visibility),
  ).toBe('visible')
  expect(await page.evaluate(() => document.querySelectorAll('[data-fps-prev-visibility]').length)).toBe(0)
  // A failed capture delivers nothing.
  expect(probe.dataUrl).toBeNull()

  await other.close()
  await page.bringToFront()
  await page.close()
})

test('three consecutive captures of the same page all behave identically', async () => {
  // The injection sentinel. `executeScript` re-runs the content script on every
  // capture; without the `__fullPageShotListenerInstalled` guard the second run
  // registers a second listener with its own (null) `originalScrollY`, both
  // answer every message, and whichever calls `sendResponse` first wins. The
  // second listener answers `capture abandoned; page already restored`, so a
  // missing sentinel shows up here as a capture that fails or restores to the
  // wrong place -- and it gets more likely with each extra injection.
  const page = await openFixture(context, 'long-fixed-header.html')
  await page.evaluate(() => window.scrollTo(0, 320))

  const heights: number[] = []
  for (let run = 0; run < 3; run += 1) {
    const probe = await runCapture(context, page)
    expect(probe.error, `run ${String(run)} logged an error`).toBeNull()
    expect(probe.badge, `run ${String(run)} did not succeed`).toBe('✓')
    expect(probe.dataUrl, `run ${String(run)} produced no image`).not.toBeNull()
    const report = await analyzePng(decoder, dataUrlToBuffer(probe.dataUrl ?? ''), {
      colors: [HEADER],
    })
    heights.push(report.height)
    expect(report.fullyTransparentRows, `run ${String(run)} has unpainted rows`).toEqual([])
    // Still exactly one header, on every run.
    expect(report.colors[HEADER]?.minY).toBe(0)
    expect(report.colors[HEADER]?.maxY).toBeLessThanOrEqual(
      Math.round(HEADER_HEIGHT_CSS * (await readPageFacts(page)).devicePixelRatio),
    )
    expect(await page.evaluate(() => window.scrollY), `run ${String(run)} lost the scroll`).toBe(320)
  }
  expect(new Set(heights).size, 'the three captures disagreed on height').toBe(1)
  await page.close()
})

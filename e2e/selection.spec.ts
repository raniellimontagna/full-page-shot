import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import {
  dataUrlMime,
  dataUrlToBuffer,
  grabRawFrame,
  launchExtension,
  listDownloads,
  newDownload,
  openFixture,
  overlayPresent,
  readPageFacts,
  settleCapture,
  setPrefs,
  startCapture,
  waitForOverlay,
  type CaptureProbe,
  type ExtensionHarness,
  type PageFacts,
} from './helpers/extension'
import { analyzePng, decoderPage, pngSize } from './helpers/image'

/**
 * ============================================================================
 * v1.2: area selection, driven by a real pointer in real Chromium.
 *
 * This is the only place the feature's central promise can be tested at all.
 * The overlay dims the page and draws a white-bordered rectangle over it; the
 * content script removes that overlay and waits two `requestAnimationFrame`s
 * before it replies, and only then does the service worker call
 * `captureVisibleTab`. Whether those two frames are enough for the removal to
 * have *painted* is a question about the compositor, and jsdom has no
 * compositor. Everything below is watched at a Chrome API, read off delivered
 * bytes, or read out of the page's own DOM.
 * ============================================================================
 */

/** The drag every test performs, in CSS pixels relative to the viewport. */
const FROM = { x: 100, y: 100 }
const TO = { x: 400, y: 300 }
const SELECTION_WIDTH = TO.x - FROM.x
const SELECTION_HEIGHT = TO.y - FROM.y

/**
 * `long-fixed-header.html` at `scrollY === 0`, in CSS pixels: a fixed
 * `#ff0080` header over the first 60px, then flat 100px bands alternating
 * `#eeeeee` (0-100, 200-300, ...) and `#cccccc` (100-200, 300-400, ...).
 *
 * The drag above therefore selects exactly two bands and nothing else: rows
 * 100-200 are `#cccccc`, rows 200-300 are `#eeeeee`. Both colours are flat and
 * exact, `#ffffff` appears nowhere on the page at this scroll position, and
 * the overlay's rectangle carries a 1px `#ffffff` border drawn *inside* the
 * selection edge (`box-sizing: border-box`). So an overlay that had not
 * finished painting away would put white on all four edges of the delivered
 * crop, and a backdrop still up would darken these bands off their exact
 * values.
 */
const TOP_BAND = '#cccccc'
const BOTTOM_BAND = '#eeeeee'
const OVERLAY_BORDER = '#ffffff'
const HEADER = '#ff0080'

let harness: ExtensionHarness
let context: BrowserContext
let decoder: Page

test.beforeAll(async () => {
  harness = await launchExtension()
  context = harness.context
  decoder = await decoderPage(context)
})

test.afterAll(async () => {
  await harness.close()
})

/**
 * The size the delivered image must have at `scale: 1`.
 *
 * Derived rather than hard-coded, because the two roundings are the product's
 * and have to be reproduced honestly: the offscreen document rounds each edge
 * of the CSS rect into device pixels (`planCrop`), and `scale: 1` then divides
 * the device canvas back down by the ratio (`planEncode`). On an ordinary 1x
 * display both are identities and this is 300x200; the assertions below check
 * that too, so a dpr that silently doubled the output would fail here rather
 * than agree with itself.
 */
function expectedSelectionSize(facts: PageFacts): { width: number; height: number } {
  const dpr = facts.devicePixelRatio
  const deviceWidth = Math.round(TO.x * dpr) - Math.round(FROM.x * dpr)
  const deviceHeight = Math.round(TO.y * dpr) - Math.round(FROM.y * dpr)
  return { width: Math.round(deviceWidth / dpr), height: Math.round(deviceHeight / dpr) }
}

/** Opens the fixture at the top of the page, where the band layout above holds. */
async function openSelectionFixture(): Promise<Page> {
  const page = await openFixture(context, 'long-fixed-header.html')
  await page.evaluate(() => window.scrollTo(0, 0))
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  return page
}

/** Drags from `from` to `to` with real pointer events, in several steps. */
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 10 })
  await page.mouse.up()
}

/** Starts a selection capture, waits for the overlay, drags, and collects. */
async function selectRegion(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<CaptureProbe> {
  await startCapture(context, page, 'selection')
  await waitForOverlay(page)
  await drag(page, from, to)
  return await settleCapture(context)
}

/** The four corner pixels of an image, by decoding one column at each edge. */
async function corners(
  bytes: Buffer,
  colors: string[],
): Promise<{ topLeft: string; bottomLeft: string; topRight: string; bottomRight: string }> {
  const { width } = pngSize(bytes)
  const left = await analyzePng(decoder, bytes, { probeX: 0, colors })
  const right = await analyzePng(decoder, bytes, { probeX: width - 1, colors })
  return {
    topLeft: left.firstRow,
    bottomLeft: left.lastRow,
    topRight: right.firstRow,
    bottomRight: right.lastRow,
  }
}

test('a dragged region is delivered as exactly that region, and the page is untouched', async () => {
  await setPrefs(context, {
    toClipboard: false,
    toDownload: true,
    downloadFormat: 'png',
    captureMode: 'full',
  })
  const seen = await listDownloads(harness.downloadDir)
  const page = await openSelectionFixture()
  const facts = await readPageFacts(page)

  const probe = await selectRegion(page, FROM, TO)

  expect(probe.error, 'a selection capture logged an error').toBeNull()
  expect(probe.badge).toBe('✓')
  // One `captureVisibleTab`, watched at the Chrome API. A selection is a crop
  // of what is already on screen; it must never scroll and re-shoot.
  expect(probe.frames).toBe(1)

  // The delivered pixels are the selection, at 1x.
  const bytes = dataUrlToBuffer(probe.clipboardDataUrl ?? '')
  const expected = expectedSelectionSize(facts)
  expect(expected.width).toBeGreaterThanOrEqual(SELECTION_WIDTH - 1)
  expect(expected.width).toBeLessThanOrEqual(SELECTION_WIDTH + 1)
  expect(expected.height).toBeGreaterThanOrEqual(SELECTION_HEIGHT - 1)
  expect(expected.height).toBeLessThanOrEqual(SELECTION_HEIGHT + 1)
  expect(pngSize(bytes)).toEqual(expected)

  // The four messages that interrogate or alter the document. A selection asks
  // the page exactly one thing -- where -- and nothing else.
  expect(probe.contentMessages).toContain('selectArea')
  for (const type of ['measure', 'hideFixed', 'scrollTo', 'restore']) {
    expect(probe.contentMessages, `a selection capture sent "${type}" to the page`).not.toContain(
      type,
    )
  }
  // The overlay is a real module in the page, so unlike viewport mode this
  // path does inject the content script.
  expect(probe.contentScriptInjected).toBe(true)

  // Nothing moved and nothing was left behind.
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  expect(await overlayPresent(page)).toBe(false)

  const delivered = await newDownload(harness.downloadDir, seen)
  expect(delivered.filePath).toMatch(/-selection\.png$/)
  await page.close()
})

test('a reverse drag delivers the identical region', async () => {
  await setPrefs(context, { toClipboard: false, toDownload: false })
  const page = await openSelectionFixture()
  const facts = await readPageFacts(page)

  const forward = await selectRegion(page, FROM, TO)
  const reverse = await selectRegion(page, TO, FROM)

  expect(forward.error).toBeNull()
  expect(reverse.error).toBeNull()
  const expected = expectedSelectionSize(facts)
  expect(pngSize(dataUrlToBuffer(forward.clipboardDataUrl ?? ''))).toEqual(expected)
  // Bottom-right to top-left is the same rectangle, not a negative one.
  expect(pngSize(dataUrlToBuffer(reverse.clipboardDataUrl ?? ''))).toEqual(expected)
  expect(await overlayPresent(page)).toBe(false)
  await page.close()
})

test('the overlay is on screen during the drag and absent from the shot', async () => {
  await setPrefs(context, { toClipboard: false, toDownload: false })
  const page = await openSelectionFixture()

  await startCapture(context, page, 'selection')
  await waitForOverlay(page)
  await page.mouse.move(FROM.x, FROM.y)
  await page.mouse.down()
  await page.mouse.move(TO.x, TO.y, { steps: 10 })

  // The control, and the whole reason this test is not vacuous: a raw
  // `captureVisibleTab` taken while the pointer is still down shows the
  // overlay exactly as the user sees it -- a white-bordered rectangle, and a
  // page dimmed 35% outside it, so the flat `#ff0080` header no longer exists
  // as that colour anywhere in the frame. If this frame came back clean, the
  // "absent from the shot" assertions below would prove nothing at all.
  const midDrag = await analyzePng(decoder, dataUrlToBuffer(await grabRawFrame(context, page)), {
    colors: [OVERLAY_BORDER, HEADER],
  })
  expect(midDrag.colors[OVERLAY_BORDER]?.count ?? 0).toBeGreaterThan(0)
  expect(midDrag.colors[HEADER]?.count ?? 0).toBe(0)

  // `captureVisibleTab` is rate-limited per tab; the real capture is only a
  // few dozen milliseconds away once the button comes up, so the grab above
  // has to be given room. Well inside the content script's silence watchdog.
  await page.waitForTimeout(700)
  await page.mouse.up()
  const probe = await settleCapture(context)

  expect(probe.error).toBeNull()
  const bytes = dataUrlToBuffer(probe.clipboardDataUrl ?? '')
  const report = await analyzePng(decoder, bytes, {
    colors: [TOP_BAND, BOTTOM_BAND, OVERLAY_BORDER],
  })

  // Not one white pixel: the rectangle's 1px border sits *inside* the
  // selection edge, so a removal that had not painted would ring the crop.
  expect(report.colors[OVERLAY_BORDER]?.count ?? 0).toBe(0)
  // And the two bands are still their exact, undimmed values -- every pixel of
  // the image is one or the other, so nothing was darkened by 35% either.
  const banded = (report.colors[TOP_BAND]?.count ?? 0) + (report.colors[BOTTOM_BAND]?.count ?? 0)
  expect(banded).toBe(report.width * report.height)

  // The four corner pixels, named individually: these are the pixels the
  // overlay would have touched first.
  expect(await corners(bytes, [])).toEqual({
    topLeft: TOP_BAND,
    topRight: TOP_BAND,
    bottomLeft: BOTTOM_BAND,
    bottomRight: BOTTOM_BAND,
  })

  expect(await overlayPresent(page)).toBe(false)
  await page.close()
})

test('Escape cancels without delivering anything, and the page never sees the key', async () => {
  // Both sinks armed, so "nothing was delivered" is a real distinction: this
  // same configuration downloads a file and writes the clipboard on success.
  await setPrefs(context, { toClipboard: true, toDownload: true, downloadFormat: 'png' })
  const page = await openSelectionFixture()
  await page.evaluate(() => {
    const scope = window as unknown as { __fpsKeydowns?: number }
    scope.__fpsKeydowns = 0
    // Bubble phase deliberately: the overlay listens on the document in the
    // *capture* phase and calls `stopImmediatePropagation`, so a capture-phase
    // counter registered here (before the overlay existed) would run first and
    // report a leak that never happened.
    window.addEventListener('keydown', () => {
      scope.__fpsKeydowns = (scope.__fpsKeydowns ?? 0) + 1
    })
  })
  const keydowns = (): Promise<number> =>
    page.evaluate(() => (window as unknown as { __fpsKeydowns?: number }).__fpsKeydowns ?? -1)

  await startCapture(context, page, 'selection')
  await waitForOverlay(page)
  await page.keyboard.press('Escape')
  const probe = await settleCapture(context)

  // A cancel is not a failure: grey `·`, never the red `✕`.
  expect(probe.badge).toBe('·')
  expect(probe.error).toBeNull()
  expect(probe.frames).toBe(0)
  expect(probe.downloadRequests).toBe(0)
  expect(probe.clipboardDataUrl).toBeNull()
  expect(probe.downloadDataUrl).toBeNull()
  // Exactly one message. In particular no `restore`: an answered selection has
  // already put the page back before it replied, and no `copyImage`.
  expect(probe.contentMessages).toEqual(['selectArea'])

  expect(await overlayPresent(page)).toBe(false)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  // The page's own Escape handling never ran -- a modal on the page would not
  // have closed behind the user's back.
  expect(await keydowns()).toBe(0)
  // And the counter works: with the overlay gone, the very next Escape lands.
  await page.keyboard.press('Escape')
  await expect.poll(keydowns).toBe(1)
  await page.close()
})

test('a long deliberation does not time the overlay out', async () => {
  // The content script's restore watchdog is 10s of *silence*; pointer
  // activity re-arms it. A user moving the pointer around while deciding what
  // to frame must not have the overlay pulled out from under them, so this
  // idles past the watchdog before drawing anything at all.
  test.setTimeout(180_000)
  await setPrefs(context, { toClipboard: false, toDownload: false })
  const page = await openSelectionFixture()

  await startCapture(context, page, 'selection')
  await waitForOverlay(page)
  for (let second = 0; second < 11; second += 1) {
    await page.waitForTimeout(1_000)
    // Hovering, not dragging: no button is down, so nothing is being drawn.
    await page.mouse.move(600 + (second % 2), 500)
  }
  expect(await overlayPresent(page), 'the overlay was withdrawn mid-deliberation').toBe(true)

  await drag(page, FROM, TO)
  const probe = await settleCapture(context)

  expect(probe.error).toBeNull()
  expect(probe.badge).toBe('✓')
  expect(probe.frames).toBe(1)
  const facts = await readPageFacts(page)
  expect(pngSize(dataUrlToBuffer(probe.clipboardDataUrl ?? ''))).toEqual(
    expectedSelectionSize(facts),
  )
  expect(await overlayPresent(page)).toBe(false)
  await page.close()
})

test('a drag under the minimum cancels exactly like Escape', async () => {
  await setPrefs(context, { toClipboard: true, toDownload: true, downloadFormat: 'png' })
  const page = await openSelectionFixture()

  // 2px in each axis, under `MIN_SELECTION_PX` (4): a slip of the hand while
  // clicking, not a region. Nothing is captured and nothing goes wrong.
  const probe = await selectRegion(page, FROM, { x: FROM.x + 2, y: FROM.y + 2 })

  expect(probe.badge).toBe('·')
  expect(probe.error).toBeNull()
  expect(probe.frames).toBe(0)
  expect(probe.downloadRequests).toBe(0)
  expect(probe.clipboardDataUrl).toBeNull()
  expect(probe.downloadDataUrl).toBeNull()
  expect(probe.contentMessages).toEqual(['selectArea'])
  expect(await overlayPresent(page)).toBe(false)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  await page.close()
})

test('scale and format still apply to a selection', async () => {
  await setPrefs(context, {
    toClipboard: true,
    toDownload: true,
    scale: 1,
    downloadFormat: 'jpeg',
  })
  const seen = await listDownloads(harness.downloadDir)
  const page = await openSelectionFixture()
  const facts = await readPageFacts(page)

  const probe = await selectRegion(page, FROM, TO)

  expect(probe.error).toBeNull()
  expect(probe.badge).toBe('✓')
  expect(probe.downloadRequests).toBe(1)

  // The clipboard is PNG whatever the download format is, and it is still the
  // selection, still at 1x.
  expect(dataUrlMime(probe.clipboardDataUrl ?? '')).toBe('image/png')
  expect(dataUrlMime(probe.downloadDataUrl ?? '')).toBe('image/jpeg')
  expect(pngSize(dataUrlToBuffer(probe.clipboardDataUrl ?? ''))).toEqual(
    expectedSelectionSize(facts),
  )

  const delivered = await newDownload(harness.downloadDir, seen, { extension: '.jpg' })
  expect(delivered.filePath).toMatch(/-selection\.jpg$/)
  // The file's own magic number, off disk: JPEG starts FF D8.
  expect(delivered.bytes.subarray(0, 2).toString('hex')).toBe('ffd8')
  await page.close()
})

/**
 * The suite above runs entirely at the host's own dpr (1 on ordinary CI
 * runners), so the default `scale: 1` never actually resamples anything --
 * `planEncode` divides device pixels back down by the same 1:1 ratio it
 * multiplied by. At `deviceScaleFactor: 2`, `scale: 1` is a genuine 2x → 1x
 * downscale, which is exactly where adjacent source rows can blend at a
 * boundary: if the resample kernel ever pulled in a neighbouring band, or the
 * crop's device-pixel edges landed a row off from where `planCrop` intended,
 * the flat `#cccccc`/`#eeeeee` bands below would stop being flat. A separate
 * harness is used (rather than parametrising the suite above) because
 * `--force-device-scale-factor` is a launch-time Chromium flag.
 */
test.describe('at device scale factor 2', () => {
  test('a dragged region survives the 1x downscale as exact, unblended bands', async () => {
    const harness2 = await launchExtension({ deviceScaleFactor: 2 })
    try {
      const context2 = harness2.context
      // The decoder is just a blank page that decodes bytes via canvas -- it
      // has no dependency on the extension, so the outer one (from the dpr-1
      // harness in `beforeAll`) works fine here too.
      await setPrefs(context2, {
        toClipboard: true,
        toDownload: false,
        scale: 1,
        downloadFormat: 'png',
      })
      const page = await openFixture(context2, 'long-fixed-header.html')
      await page.evaluate(() => window.scrollTo(0, 0))
      const facts = await readPageFacts(page)
      expect(facts.devicePixelRatio).toBe(2)

      await startCapture(context2, page, 'selection')
      await waitForOverlay(page)
      await drag(page, FROM, TO)
      const probe = await settleCapture(context2)

      expect(probe.error).toBeNull()
      expect(probe.badge).toBe('✓')
      const bytes = dataUrlToBuffer(probe.clipboardDataUrl ?? '')

      // The delivered size is still the CSS-pixel selection: `scale: 1`
      // downscales the 2x-captured crop back down.
      expect(pngSize(bytes)).toEqual(expectedSelectionSize(facts))

      // Every pixel is one of the two exact bands -- nothing in between, which
      // is what a blended seam or an off-by-a-row crop would produce.
      const report = await analyzePng(decoder, bytes, {
        colors: [TOP_BAND, BOTTOM_BAND, OVERLAY_BORDER],
      })
      expect(report.colors[OVERLAY_BORDER]?.count ?? 0).toBe(0)
      const banded = (report.colors[TOP_BAND]?.count ?? 0) + (report.colors[BOTTOM_BAND]?.count ?? 0)
      expect(banded).toBe(report.width * report.height)

      // The four corners, named individually, exactly as at 1x.
      expect(await corners(bytes, [])).toEqual({
        topLeft: TOP_BAND,
        topRight: TOP_BAND,
        bottomLeft: BOTTOM_BAND,
        bottomRight: BOTTOM_BAND,
      })

      await page.close()
    } finally {
      await harness2.close()
    }
  })
})

import { expect, test } from '@playwright/test'
import {
  dataUrlToBuffer,
  grabRawFrame,
  launchExtension,
  openFixture,
  readPageFacts,
  runCapture,
  setPrefs,
} from './helpers/extension'
import { analyzePng, decoderPage, pngSize } from './helpers/image'

const BOTTOM_BAND = '#ff00ff'

/**
 * ============================================================================
 * DEFECT, REPRODUCED HERE. Read before touching a `test.fail()` below.
 *
 * At devicePixelRatio 1.25, `window.innerHeight` is not a faithful measure of
 * the viewport, and the frame grid is built from it:
 *
 *   real capture surface     1017 device px  (measured from captureVisibleTab)
 *   window.innerHeight        814 CSS px     (Chrome rounds it to an integer)
 *   window.visualViewport.height  813.6 CSS px  (the true, fractional value)
 *   Math.round(814 * 1.25)   1018            <- what the planner uses
 *   Math.round(813.6 * 1.25) 1017            <- what the surface actually is
 *
 * So `frameHeight` is one device pixel taller than any frame really is.
 * `drawImage` clamps each draw to the bitmap's real 1017 rows, so every frame
 * leaves the last row of its 1018-row slot unpainted, and the final frame --
 * anchored at `canvasHeight - frameHeight` -- leaves the very last row of the
 * image unpainted too. Measured on a three-frame page: transparent rows at
 * y=1017 and y=2205 (the bottom edge of the screenshot).
 *
 * This is exactly the failure the clamping arithmetic in `page-metrics.ts` and
 * `stitch-plan.ts` was written to prevent. Those modules are not wrong; their
 * *input* is. The unit tests cannot see it because they feed the planner the
 * same integer `viewportHeight` the content script measures, so both sides
 * agree on a frame height the browser never produces.
 *
 * Likely fix: measure with `window.visualViewport` (fractional) rather than
 * `window.innerWidth`/`innerHeight` in `src/content/scroll-driver.ts`, falling
 * back to `innerHeight` where `visualViewport` is unavailable. `1017` above is
 * what `Math.round(visualViewport.height * dpr)` already gives.
 *
 * dpr 1, 1.1, 1.3, 1.5, 1.75, 2 and 2.5 were all measured clean on this
 * window size; 1.25 is the one that lands on a half-pixel. The bug is not
 * "1.25 is special" -- it is that any (viewport, dpr) pair whose true CSS
 * height is not an integer can land there.
 * ============================================================================
 */

// 1.25 and 1.5 are the standard Windows and ChromeOS display scale factors,
// and they are the whole reason `page-metrics.ts` and `stitch-plan.ts` carry
// the clamping arithmetic they do. `--force-device-scale-factor` gives a real
// fractional DPR rather than a CDP metrics override, so `captureVisibleTab`
// grabs a genuinely fractional surface.
for (const dpr of [1.25, 1.5]) {
  test.describe(`device scale factor ${String(dpr)}`, () => {
    test('Chrome frames match Math.round(viewportHeight * dpr)', async () => {
      // The open question from Task 2. Every frame placement assumes a frame
      // is exactly `Math.round(viewportHeight * dpr)` device pixels tall. If
      // Chrome rounds the capture surface differently -- floor, ceil, or off
      // by one from a fractional layout viewport -- then the uniform grid in
      // `computeFramePlacements` is misaligned by that difference on every
      // frame, and nothing in the unit tests could see it.
      test.fail(dpr === 1.25, 'Chrome frames are 1017 device px where the planner assumes 1018')
      const harness = await launchExtension({ deviceScaleFactor: dpr })
      try {
        const decoder = await decoderPage(harness.context)
        const page = await openFixture(harness.context, 'long-fixed-header.html')
        const facts = await readPageFacts(page)
        expect(facts.devicePixelRatio).toBe(dpr)

        const frame = dataUrlToBuffer(await grabRawFrame(harness.context, page))
        const size = pngSize(frame)

        expect(size.height, 'Chrome disagrees with the planner about frame height').toBe(
          Math.round(facts.viewportHeight * dpr),
        )
        expect(size.width, 'Chrome disagrees with the planner about frame width').toBe(
          Math.round(facts.viewportWidth * dpr),
        )
        await decoder.close()
      } finally {
        await harness.close()
      }
    })

    test('a stitched capture has no unpainted rows and keeps its bottom edge', async () => {
      test.fail(dpr === 1.25, 'unpainted rows at y=1017 and at the bottom edge')
      const harness = await launchExtension({ deviceScaleFactor: dpr })
      try {
        const decoder = await decoderPage(harness.context)
        await setPrefs(harness.context, { toClipboard: false, toDownload: false })
        const page = await openFixture(harness.context, 'non-multiple.html')
        const facts = await readPageFacts(page)
        const probe = await runCapture(harness.context, page)
        expect(probe.error).toBeNull()
        expect(probe.dataUrl).not.toBeNull()

        const report = await analyzePng(decoder, dataUrlToBuffer(probe.dataUrl ?? ''), {
          colors: [BOTTOM_BAND],
        })
        const frameHeight = Math.round(facts.viewportHeight * dpr)
        const steps = Math.ceil(facts.scrollHeight / facts.viewportHeight)
        expect(report.height).toBe(
          Math.min(Math.round(facts.scrollHeight * dpr), steps * frameHeight),
        )
        // The assertion five review rounds of fractional-DPI arithmetic exist
        // to make: no row of the canvas was left unpainted by any frame.
        expect(report.fullyTransparentRows, 'unpainted rows in the stitched PNG').toEqual([])
        expect(report.translucentRows, 'partially unpainted rows').toEqual([])
        expect(report.colors[BOTTOM_BAND]?.maxY).toBe(report.height - 1)
        expect(report.lastRow).toBe(BOTTOM_BAND)
        await decoder.close()
      } finally {
        await harness.close()
      }
    })
  })
}

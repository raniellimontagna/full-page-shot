# Developing Full Page Shot

Everything you need to build, test and change the extension. For what it does
and how to use it, see the [README](../README.md).

## Setup

Requirements: Node 22 and [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts Vite in watch mode. To load the extension in Chrome:

1. Run `pnpm build` (a one-off production build; `pnpm dev` keeps rebuilding
   into the same folder while you work).
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the `dist/` folder.
4. After each change, click the reload icon on the extension's card in
   `chrome://extensions` (or re-run `pnpm build` if `pnpm dev` isn't running).

## Project layout

- `src/background` — the MV3 service worker: capture loop orchestration, the
  download sink, and the dispatcher that runs both sinks (the clipboard write
  itself lives in `src/content/clipboard.ts`, which runs in the captured tab).
- `src/content` — the content script injected into the page being captured.
- `src/offscreen` — the offscreen document that stitches frames on a canvas.
- `src/core` — pure, environment-agnostic logic (frame planning, geometry).
- `src/options` — the options page (React) where the sinks, the default
  capture mode, the scale and the download format are configured, and where
  the shortcuts Chrome actually assigned are listed.
- `src/shared` — code shared across the above.

The design spec, with the reasoning behind each of these pieces, is
[`docs/superpowers/specs/2026-09-01-full-page-shot-design.md`](superpowers/specs/2026-09-01-full-page-shot-design.md).

## Testing

The project has four independent checks.

| Layer | Command | What it covers |
|---|---|---|
| Unit tests | `pnpm test` (or `pnpm test:watch`) | Vitest, run under `jsdom` for `tests/content/**` and `tests/options/**`, and under Node for everything else. |
| Type checking | `pnpm typecheck` | The main `tsconfig.json` plus the separate `e2e/tsconfig.json` (the e2e helpers and specs run under Node and are typed independently from the browser/service-worker sources). |
| Linting | `pnpm lint` | [oxlint](https://oxc.rs/docs/guide/usage/linter.html) over `src`, `tests`, and `e2e`. |
| End-to-end tests | `pnpm test:e2e` | Playwright driving a real Chromium with the built extension loaded (`chromium.launchPersistentContext`), against fixture pages served locally. Run `pnpm exec playwright install chromium` once beforehand. |

Coverage for the unit suite is collected with v8 and reported as `lcov`:

```bash
pnpm test --coverage
```

This writes `coverage/lcov.info`, which is what CI uploads to Codecov.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and on every pull
request: install, lint, typecheck, unit tests with coverage, then the full
Playwright e2e suite against a real headless Chromium, followed by a Codecov
upload.

The e2e step needs no virtual display. `e2e/helpers/extension.ts` launches
Chromium with `channel: 'chromium'` and `headless: true` by default —
Playwright's newer headless mode, which (unlike the legacy headless mode)
supports loading unpacked extensions — so `xvfb-run` is unnecessary here.

The workflow uploads coverage with `codecov/codecov-action` using
`secrets.CODECOV_TOKEN`. Create it in Codecov (this repository → Settings →
copy the upload token) and add it as a repository secret named
`CODECOV_TOKEN` in GitHub Settings → Secrets and variables → Actions. The
upload step is set to `fail_ci_if_error: false`, so a missing or invalid token
does not fail the build — it only skips the coverage upload.

## Why scroll-and-stitch, not `chrome.debugger`

Chrome's DevTools Protocol offers `Page.captureScreenshot` with
`captureBeyondViewport: true`, which would produce a pixel-perfect full-page
image in a single call — no stitching, no risk of a fixed header appearing
more than once. Full Page Shot deliberately does not use it. Attaching the
`chrome.debugger` API:

- shows Chrome's persistent "DevTools is debugging this tab" banner for the
  duration of the capture,
- carries an aggressive install-time permission warning and heavier Chrome
  Web Store review,
- and breaks outright if the user already has DevTools open on the tab.

Scroll-and-stitch trades that friction for engineering complexity the project
controls directly: a capture loop, an offscreen-document stitcher, and the
geometry work to keep seams aligned.

## Known limitations, in detail

- **Seams drift by a few pixels on pages with a fractional
  `devicePixelRatio`** (1.25, 1.5, 1.75 — common on Windows and ChromeOS
  scaling). Frames are stitched on a uniform pixel grid, but the page scrolls
  by an exact `viewportHeight × dpr`; the sub-pixel difference between the two
  accumulates down the page. In the worst case measured this is on the order
  of tens of device pixels on a very long page; on typical pages it is a few
  pixels. The last seam is exempt — it is anchored to the bottom of the
  canvas, so the end of the page never gets cut off. This is a deliberate,
  bounded trade-off against the alternative (independently-rounded frame
  positions), which produces uncovered gaps or a cropped page bottom instead.
  See the design spec's [Limitações
  conhecidas](superpowers/specs/2026-09-01-full-page-shot-design.md#limitações-conhecidas)
  section for the full analysis, and `tests/core/stitch-plan.test.ts` for the
  property test that locks the bound.
- **Very tall/large captures can fail on pages that produce a PNG above
  roughly 48 MB.** The stitched image crosses the offscreen document and the
  service worker as a base64 data URL over `chrome.runtime.sendMessage`,
  which enforces an internal ~64 MiB message-size cap; base64 encoding adds
  about 33% overhead, so a ~48 MB PNG is close to where that cap is hit.
  Extremely long or high-DPI pages can exceed it.
- **Pages that scroll a nested container** instead of the document — some
  single-page apps — capture only the visible viewport in full-page mode.

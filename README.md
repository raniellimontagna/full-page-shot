# Full Page Shot

[![CI](https://github.com/raniellimontagna/full-page-shot/actions/workflows/ci.yml/badge.svg)](https://github.com/raniellimontagna/full-page-shot/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/raniellimontagna/full-page-shot/branch/main/graph/badge.svg)](https://codecov.io/gh/raniellimontagna/full-page-shot)

A Chrome extension that captures the **entire scrollable page** — not just the
visible viewport — in one click, and delivers the image to the clipboard, as a
PNG download, or both.

## What it does

Click the toolbar button (or press Ctrl+Shift+Y, Cmd+Shift+Y on a Mac) and
the extension:

1. Scrolls the active tab in viewport-sized steps, capturing a screenshot at
   each stop.
2. Stitches the frames together into a single PNG that represents the full
   page, including everything that was ever off-screen.
3. Delivers the result to the clipboard and/or as a download, according to
   the preferences set on the extension's options page.

The page is left exactly as it was found: scroll position and any fixed
header are restored once the capture finishes (or fails partway through).

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
geometry work to keep seams aligned. The full reasoning, including the
rejected alternative and the trade-off, lives in the design spec:
[`docs/superpowers/specs/2026-09-01-full-page-shot-design.md`](docs/superpowers/specs/2026-09-01-full-page-shot-design.md).

## Development

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

### Project layout

- `src/background` — the MV3 service worker: capture loop orchestration, the
  download sink, and the dispatcher that runs both sinks (the clipboard write
  itself lives in `src/content/clipboard.ts`, which runs in the captured tab).
- `src/content` — the content script injected into the page being captured.
- `src/offscreen` — the offscreen document that stitches frames on a canvas.
- `src/core` — pure, environment-agnostic logic (frame planning, geometry).
- `src/options` — the options page (React) where sinks are configured.
- `src/shared` — code shared across the above.

## Testing

The project has three independent test layers.

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

**First push checklist for the repository owner:** the workflow uploads
coverage with `codecov/codecov-action` using `secrets.CODECOV_TOKEN`. That
secret does not exist until you create it (Codecov → this repository → Settings
→ copy the upload token → add it as a repository secret named
`CODECOV_TOKEN` in GitHub Settings → Secrets and variables → Actions). The
coverage upload step is set to `fail_ci_if_error: false`, so a missing or
invalid token will not fail the build — it will just skip the coverage
upload.

## Known limitations

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
  conhecidas](docs/superpowers/specs/2026-09-01-full-page-shot-design.md#limitações-conhecidas)
  section for the full analysis, and `tests/core/stitch-plan.test.ts` for the
  property test that locks the bound.
- **Very tall/large captures can fail on pages that produce a PNG above
  roughly 48 MB.** The stitched image crosses the offscreen document and the
  service worker as a base64 data URL over `chrome.runtime.sendMessage`,
  which enforces an internal ~64 MiB message-size cap; base64 encoding adds
  about 33% overhead, so a ~48 MB PNG is close to where that cap is hit.
  Extremely long or high-DPI pages can exceed it.

## License

ISC

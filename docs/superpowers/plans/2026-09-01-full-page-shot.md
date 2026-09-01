# full-page-shot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Manifest V3 Chrome extension that captures the full scrollable page in one click and delivers the PNG to the clipboard, to a download, or both.

**Architecture:** A service worker orchestrates the capture: it injects a content script that measures and scrolls the page, calls `chrome.tabs.captureVisibleTab` once per viewport-sized step, and streams each frame to an offscreen document that draws them into a single canvas. The scroll arithmetic and the frame placement arithmetic are pure functions in `src/core/`, unit-tested without a browser; the DOM-touching and Chrome-API-touching layers are thin and covered end-to-end with Playwright.

**Tech Stack:** Vite 8, `@crxjs/vite-plugin` 2.7.1, TypeScript 7, React 19 (options page only), Vitest 4, Playwright 1.62, GitHub Actions, Codecov.

**Spec:** `docs/superpowers/specs/2026-09-01-full-page-shot-design.md`

## Global Constraints

- Manifest V3. Manifest permissions are exactly: `activeTab`, `scripting`, `offscreen`, `downloads`, `clipboardWrite`, `storage`. Adding any other permission requires revisiting the spec — `debugger` in particular was rejected on purpose. (`storage` is not in the spec's list; it is required by the options page in Task 8 and raises no install warning. Noted here as a deliberate, minimal addition.)
- The content script is injected on demand via `chrome.scripting.executeScript`. It is **never** declared in `manifest.json` under `content_scripts`.
- Page restoration (scroll position and hidden fixed elements) must run in a `finally` block and must be idempotent. A failed capture must never leave the user's page altered. This outranks producing an image.
- Frames are forwarded to the offscreen document one at a time. The service worker never accumulates an array of frame data URLs.
- Horizontal scrolling is out of scope for v1: capture the column at `scrollX = 0` with width `viewportWidth`.
- Exact dependency versions (latest as of 2026-09-01): `vite@8.2.2`, `@crxjs/vite-plugin@2.7.1`, `typescript@7.0.2`, `vitest@4.1.11`, `@playwright/test@1.62.1`, `react@19.2.8`, `react-dom@19.2.8`, `@vitejs/plugin-react@6.1.1`, `@types/chrome@0.2.7`, `jsdom@30.0.1`. If TypeScript 7 causes tooling friction, fall back to `typescript@5.9.x` and note it in the commit — do not silently downgrade anything else.
- Commit messages in English, Conventional Commits style.
- Package manager: `pnpm`.

---

### Task 1: Project scaffold and a loadable extension

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `vite.config.ts`, `.gitignore`, `src/manifest.config.ts`, `src/background/index.ts`, `public/icons/icon16.png`, `public/icons/icon32.png`, `public/icons/icon48.png`, `public/icons/icon128.png`
- Test: `tests/manifest.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `defineManifest` config exported from `src/manifest.config.ts` as default; build output in `dist/`

- [ ] **Step 1: Initialize the package and install dependencies**

```bash
cd ~/Projetos/pessoal/full-page-shot
pnpm init
pnpm add -D vite@8.2.2 @crxjs/vite-plugin@2.7.1 typescript@7.0.2 vitest@4.1.11 @types/chrome@0.2.7 jsdom@30.0.1
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
dist/
coverage/
.DS_Store
*.local
test-results/
playwright-report/
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["chrome", "vite/client"],
    "jsx": "react-jsx"
  },
  "include": ["src", "tests", "vite.config.ts"]
}
```

- [ ] **Step 4: Write `src/manifest.config.ts`**

```ts
import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Full Page Shot',
  version: '0.1.0',
  description: 'Capture the entire scrollable page in one click.',
  minimum_chrome_version: '116',
  permissions: ['activeTab', 'scripting', 'offscreen', 'downloads', 'clipboardWrite', 'storage'],
  // NOTE: do NOT list the content script under `web_accessible_resources` here.
  // CRXJS copies WAR entries verbatim, so that emits raw uncompiled TypeScript.
  // The content script is instead registered by importing it in the service
  // worker with the `?script&iife` suffix — see src/background/index.ts.
  action: {
    default_title: 'Capture full page',
    default_icon: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  },
  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
})
```

`minimum_chrome_version: '116'` is the floor for the `offscreen` API with the `CLIPBOARD` reason.

- [ ] **Step 5: Write `vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './src/manifest.config'

export default defineConfig({
  plugins: [crx({ manifest })],
  build: { target: 'esnext' },
  test: {
    environment: 'node',
    coverage: { provider: 'v8', include: ['src/**/*.ts'], reporter: ['text', 'lcov'] },
  },
})
```

- [ ] **Step 6: Add scripts to `package.json`**

```json
{
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 7: Write the failing manifest test**

`tests/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import manifest from '../src/manifest.config'

describe('manifest', () => {
  it('targets Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3)
  })

  it('requests exactly the permissions the spec allows', () => {
    expect([...(manifest.permissions ?? [])].sort()).toEqual(
      ['activeTab', 'clipboardWrite', 'downloads', 'offscreen', 'scripting', 'storage'].sort(),
    )
  })

  it('never requests the debugger permission', () => {
    expect(manifest.permissions).not.toContain('debugger')
  })

  it('does not declare static content scripts', () => {
    expect(manifest).not.toHaveProperty('content_scripts')
  })
})
```

- [ ] **Step 8: Run the test**

Run: `pnpm test`
Expected: the assertions describe the manifest object, which already exists, so this test legitimately passes on the first run. Task 1 is scaffolding — there is no behaviour here to drive red-green, and inventing a failing case would be theatre. What matters is that Vitest resolves and runs the file; if it errors on configuration rather than assertions, fix the configuration before moving on. Every later task has a real red phase.

- [ ] **Step 9: Write the minimal service worker**

`src/background/index.ts`:

```ts
chrome.action.onClicked.addListener((tab) => {
  console.log('[full-page-shot] action clicked on tab', tab.id)
})
```

- [ ] **Step 10: Generate placeholder icons**

Any solid-color PNGs at 16, 32, 48 and 128 px in `public/icons/`. Real artwork lands in Task 11 — the build needs the files to exist now.

```bash
mkdir -p public/icons
# A 1x1 opaque PNG, scaled up to each required size.
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' \
  | base64 -d > /tmp/fps-seed.png
for s in 16 32 48 128; do
  sips -z $s $s /tmp/fps-seed.png --out "public/icons/icon$s.png" >/dev/null
done
ls -la public/icons
```

Expected: four PNGs. Real artwork replaces them in Task 11 — the build only needs the files to exist now.

- [ ] **Step 11: Run the test and the build**

Run: `pnpm test && pnpm build`
Expected: tests PASS; `dist/` contains `manifest.json` and the background bundle.

- [ ] **Step 12: Load the extension manually and confirm**

Open `chrome://extensions`, enable Developer mode, "Load unpacked", select `dist/`. Click the extension icon on any page. Open the service worker console from the extensions page and confirm the log line appears.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat: scaffold MV3 extension with Vite and CRXJS"
```

---

### Task 2: Core types and capture planning (`page-metrics`)

**Files:**
- Create: `src/core/types.ts`, `src/core/page-metrics.ts`
- Test: `tests/core/page-metrics.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface PageMeasurements { scrollWidth: number; scrollHeight: number; viewportWidth: number; viewportHeight: number; devicePixelRatio: number; scrollX: number; scrollY: number }`
  - `interface CaptureStep { index: number; scrollY: number }`
  - `interface CapturePlan { steps: CaptureStep[]; canvasWidth: number; canvasHeight: number; truncated: boolean }`
  - `const CANVAS_LIMITS: { maxDimension: number; maxArea: number }`
  - `function planCapture(m: PageMeasurements): CapturePlan`

Canvas dimensions in `CapturePlan` are in **device pixels** (CSS pixels × `devicePixelRatio`), because that is what `captureVisibleTab` returns. `scrollY` in `CaptureStep` is in **CSS pixels**, because that is what `window.scrollTo` takes. Keeping the two unit systems explicit at the type boundary is deliberate — mixing them is the most likely source of a subtly wrong image.

- [ ] **Step 1: Write `src/core/types.ts`**

```ts
export interface PageMeasurements {
  scrollWidth: number
  scrollHeight: number
  viewportWidth: number
  viewportHeight: number
  devicePixelRatio: number
  scrollX: number
  scrollY: number
}

/** scrollY is in CSS pixels — the unit window.scrollTo expects. */
export interface CaptureStep {
  index: number
  scrollY: number
}

/** canvasWidth/canvasHeight are in device pixels — the unit captureVisibleTab returns. */
export interface CapturePlan {
  steps: CaptureStep[]
  canvasWidth: number
  canvasHeight: number
  truncated: boolean
}
```

- [ ] **Step 2: Write the failing tests**

`tests/core/page-metrics.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CANVAS_LIMITS, planCapture } from '../../src/core/page-metrics'
import type { PageMeasurements } from '../../src/core/types'

const base: PageMeasurements = {
  scrollWidth: 1200,
  scrollHeight: 3000,
  viewportWidth: 1200,
  viewportHeight: 800,
  devicePixelRatio: 1,
  scrollX: 0,
  scrollY: 0,
}

describe('planCapture', () => {
  it('produces a single step when the page fits in the viewport', () => {
    const plan = planCapture({ ...base, scrollHeight: 600 })
    expect(plan.steps).toEqual([{ index: 0, scrollY: 0 }])
    expect(plan.canvasHeight).toBe(600)
  })

  it('produces one step per viewport for an exact multiple', () => {
    const plan = planCapture({ ...base, scrollHeight: 2400 })
    expect(plan.steps.map((s) => s.scrollY)).toEqual([0, 800, 1600])
  })

  it('clamps the final step so it never scrolls past the bottom', () => {
    const plan = planCapture({ ...base, scrollHeight: 2000 })
    // 2000 / 800 => 3 steps; the last one would be 1600 but the page bottoms out at 1200
    expect(plan.steps.map((s) => s.scrollY)).toEqual([0, 800, 1200])
  })

  it('scales the canvas by devicePixelRatio', () => {
    const plan = planCapture({ ...base, scrollHeight: 1600, devicePixelRatio: 2 })
    expect(plan.canvasWidth).toBe(2400)
    expect(plan.canvasHeight).toBe(3200)
  })

  it('truncates a page that exceeds the max canvas dimension', () => {
    const plan = planCapture({ ...base, scrollHeight: CANVAS_LIMITS.maxDimension + 5000 })
    expect(plan.truncated).toBe(true)
    expect(plan.canvasHeight).toBeLessThanOrEqual(CANVAS_LIMITS.maxDimension)
  })

  it('truncates a page that exceeds the max canvas area', () => {
    const wide = Math.floor(CANVAS_LIMITS.maxArea / 10000)
    const plan = planCapture({
      ...base,
      scrollWidth: wide,
      viewportWidth: wide,
      scrollHeight: 20000,
    })
    expect(plan.truncated).toBe(true)
    expect(plan.canvasWidth * plan.canvasHeight).toBeLessThanOrEqual(CANVAS_LIMITS.maxArea)
  })

  it('never emits a step below the truncated height', () => {
    const plan = planCapture({ ...base, scrollHeight: CANVAS_LIMITS.maxDimension + 5000 })
    const maxScroll = Math.max(...plan.steps.map((s) => s.scrollY))
    expect(maxScroll).toBeLessThanOrEqual(plan.canvasHeight / base.devicePixelRatio)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run tests/core/page-metrics.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/core/page-metrics"`.

- [ ] **Step 4: Write `src/core/page-metrics.ts`**

```ts
import type { CapturePlan, CaptureStep, PageMeasurements } from './types'

/**
 * Chrome's 2D canvas ceilings. Exceeding either one yields a blank canvas
 * with no error, so the plan has to clamp before a single frame is captured.
 */
export const CANVAS_LIMITS = {
  maxDimension: 65_535,
  maxArea: 268_435_456,
} as const

export function planCapture(m: PageMeasurements): CapturePlan {
  const dpr = m.devicePixelRatio
  const widthCss = m.viewportWidth
  // Not max(scrollHeight, viewportHeight): a 600px page in an 800px viewport
  // must yield a 600px canvas, not 800px with 200px of blank tail. Task 3's
  // sourceHeight clamp trims the frame's overhang.
  let heightCss = m.scrollHeight
  let truncated = false

  // Derive the height ceiling from the *rounded* canvas width, not the raw
  // CSS width: rounding up a fractional width would otherwise push the final
  // area back over the limit.
  const canvasWidth = Math.round(widthCss * dpr)
  const maxHeightByDimension = CANVAS_LIMITS.maxDimension / dpr
  const maxHeightByArea = CANVAS_LIMITS.maxArea / (canvasWidth * dpr)
  const maxHeightCss = Math.floor(Math.min(maxHeightByDimension, maxHeightByArea))

  if (heightCss > maxHeightCss) {
    heightCss = maxHeightCss
    truncated = true
  }

  const stepCount = Math.max(1, Math.ceil(heightCss / m.viewportHeight))
  const lastScrollY = Math.max(0, heightCss - m.viewportHeight)

  const steps: CaptureStep[] = []
  for (let index = 0; index < stepCount; index += 1) {
    steps.push({ index, scrollY: Math.min(index * m.viewportHeight, lastScrollY) })
  }

  return {
    steps,
    canvasWidth,
    canvasHeight: Math.round(heightCss * dpr),
    truncated,
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/core/page-metrics.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/core tests/core
git commit -m "feat(core): add capture planning with canvas limit clamping"
```

---

### Task 3: Frame placement arithmetic (`stitch-plan`)

**Files:**
- Create: `src/core/stitch-plan.ts`
- Test: `tests/core/stitch-plan.test.ts`

**Interfaces:**
- Consumes: `CapturePlan`, `PageMeasurements` from Task 2
- Produces:
  - `interface FramePlacement { index: number; destY: number; sourceHeight: number }`
  - `function computeFramePlacements(plan: CapturePlan, m: PageMeasurements): FramePlacement[]`

The last step overlaps the one before it, because it was clamped to the page bottom. Drawing each frame at `scrollY × dpr` makes the overlap resolve itself: the final frame paints over the duplicated band with identical content. `sourceHeight` exists to trim the final frame when truncation cut the canvas mid-viewport.

- [ ] **Step 1: Write the failing tests**

`tests/core/stitch-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { planCapture } from '../../src/core/page-metrics'
import { computeFramePlacements } from '../../src/core/stitch-plan'
import type { PageMeasurements } from '../../src/core/types'

const base: PageMeasurements = {
  scrollWidth: 1200,
  scrollHeight: 2000,
  viewportWidth: 1200,
  viewportHeight: 800,
  devicePixelRatio: 1,
  scrollX: 0,
  scrollY: 0,
}

describe('computeFramePlacements', () => {
  it('places each frame at its scroll offset in device pixels', () => {
    const m = { ...base, scrollHeight: 2400 }
    const placements = computeFramePlacements(planCapture(m), m)
    expect(placements.map((p) => p.destY)).toEqual([0, 800, 1600])
  })

  it('overlaps the clamped final frame instead of leaving a gap', () => {
    const placements = computeFramePlacements(planCapture(base), base)
    expect(placements.map((p) => p.destY)).toEqual([0, 800, 1200])
  })

  it('covers every row of the canvas with no gap', () => {
    const plan = planCapture(base)
    const placements = computeFramePlacements(plan, base)
    const covered = new Set<number>()
    for (const p of placements) {
      for (let y = p.destY; y < p.destY + p.sourceHeight; y += 1) covered.add(y)
    }
    for (let y = 0; y < plan.canvasHeight; y += 1) {
      expect(covered.has(y), `row ${y} uncovered`).toBe(true)
    }
  })

  it('scales placements by devicePixelRatio', () => {
    const m = { ...base, scrollHeight: 2400, devicePixelRatio: 2 }
    const placements = computeFramePlacements(planCapture(m), m)
    expect(placements.map((p) => p.destY)).toEqual([0, 1600, 3200])
    expect(placements[0]?.sourceHeight).toBe(1600)
  })

  it('trims the final frame so nothing is drawn past the canvas', () => {
    const plan = planCapture(base)
    const placements = computeFramePlacements(plan, base)
    for (const p of placements) {
      expect(p.destY + p.sourceHeight).toBeLessThanOrEqual(plan.canvasHeight)
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/core/stitch-plan.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/core/stitch-plan"`.

- [ ] **Step 3: Write `src/core/stitch-plan.ts`**

```ts
import type { CapturePlan, PageMeasurements } from './types'

export interface FramePlacement {
  index: number
  /** Y offset on the destination canvas, in device pixels. */
  destY: number
  /** How many device-pixel rows of the frame to draw. */
  sourceHeight: number
}

export function computeFramePlacements(
  plan: CapturePlan,
  m: PageMeasurements,
): FramePlacement[] {
  const dpr = m.devicePixelRatio
  const frameHeight = Math.round(m.viewportHeight * dpr)

  // With a fractional devicePixelRatio (1.25, 1.5, 1.75 — the common Windows
  // and ChromeOS scale factors), round(scrollY * dpr) does not advance by
  // round(viewportHeight * dpr) each step. Rounding each destY independently
  // lets the drift open a gap no frame draws: at dpr 1.25, viewportHeight 801,
  // scrollHeight 2500, device row 2002 falls between frame 1's reach (2001)
  // and frame 2's independently-rounded start (2003).
  //
  // Capping sourceHeight does NOT fix this — the gap is between one frame's
  // reach and the next frame's position, so the two must be coupled: each
  // destY is pulled back to at most the previous frame's last drawable row.
  // That also keeps every sourceHeight <= frameHeight, so a consumer clamping
  // the draw call to the bitmap's real height can never reopen the gap.
  const destYs: number[] = []
  for (const [i, step] of plan.steps.entries()) {
    const raw = Math.round(step.scrollY * dpr)
    const prev = destYs[i - 1]
    destYs.push(prev === undefined ? raw : Math.min(raw, prev + frameHeight))
  }

  return plan.steps.map((step, i) => {
    const destY = destYs[i] ?? 0
    const nextDestY = destYs[i + 1] ?? plan.canvasHeight
    const span = Math.min(nextDestY, plan.canvasHeight) - destY
    const sourceHeight = Math.max(0, Math.min(frameHeight, span))
    return { index: step.index, destY, sourceHeight }
  })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/core/stitch-plan.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/stitch-plan.ts tests/core/stitch-plan.test.ts
git commit -m "feat(core): add frame placement arithmetic for stitching"
```

---

### Task 4: Message protocol and hiding fixed elements

**Files:**
- Create: `src/shared/messages.ts`, `src/content/fixed-elements.ts`
- Test: `tests/content/fixed-elements.test.ts`

**Interfaces:**
- Consumes: `PageMeasurements` from Task 2
- Produces:
  - `type ContentRequest = { type: 'measure' } | { type: 'hideFixed' } | { type: 'scrollTo'; y: number } | { type: 'restore' }`
  - `type ContentResponse = { ok: true; measurements?: PageMeasurements } | { ok: false; error: string }`
  - `function hideFixedElements(doc: Document): void`
  - `function restoreFixedElements(doc: Document): void`

Both functions are idempotent: calling `restoreFixedElements` without a prior `hideFixedElements`, or twice in a row, is a no-op. The service worker calls restore in a `finally`, so it will happen on paths where hiding never did.

- [ ] **Step 1: Write `src/shared/messages.ts`**

```ts
import type { PageMeasurements } from '../core/types'

export type ContentRequest =
  | { type: 'measure' }
  | { type: 'hideFixed' }
  | { type: 'scrollTo'; y: number }
  | { type: 'restore' }

export type ContentResponse =
  | { ok: true; measurements?: PageMeasurements }
  | { ok: false; error: string }

export type OffscreenRequest =
  | { type: 'beginCapture'; width: number; height: number }
  | { type: 'addFrame'; dataUrl: string; destY: number; sourceHeight: number }
  | { type: 'finishCapture'; toClipboard: boolean; toDownload: boolean; filename: string }
  | { type: 'abortCapture' }

export type OffscreenResponse = { ok: true } | { ok: false; error: string }
```

- [ ] **Step 2: Configure a jsdom environment for content tests**

`environmentMatchGlobs` was REMOVED in Vitest 4 — writing it silently does nothing and the tests keep running under `node`. Use `projects` instead. Add to `vite.config.ts` under `test`:

```ts
    projects: [
      {
        extends: true,
        test: { name: 'jsdom', include: ['tests/content/**'], environment: 'jsdom' },
      },
      {
        extends: true,
        test: { name: 'node', include: ['tests/**'], exclude: ['tests/content/**'] },
      },
    ],
```

- [ ] **Step 3: Write the failing tests**

`tests/content/fixed-elements.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { hideFixedElements, restoreFixedElements } from '../../src/content/fixed-elements'

function setup(html: string) {
  document.body.innerHTML = html
}

describe('fixed elements', () => {
  beforeEach(() => setup(''))

  it('hides a position:fixed element', () => {
    setup('<header id="h" style="position: fixed">nav</header>')
    hideFixedElements(document)
    expect(document.querySelector<HTMLElement>('#h')!.style.visibility).toBe('hidden')
  })

  it('hides a position:sticky element', () => {
    setup('<div id="s" style="position: sticky">bar</div>')
    hideFixedElements(document)
    expect(document.querySelector<HTMLElement>('#s')!.style.visibility).toBe('hidden')
  })

  it('leaves static elements untouched', () => {
    setup('<p id="p">text</p>')
    hideFixedElements(document)
    expect(document.querySelector<HTMLElement>('#p')!.style.visibility).toBe('')
  })

  it('restores the exact previous inline visibility', () => {
    setup('<header id="h" style="position: fixed; visibility: visible">nav</header>')
    hideFixedElements(document)
    restoreFixedElements(document)
    expect(document.querySelector<HTMLElement>('#h')!.style.visibility).toBe('visible')
  })

  it('restores an element that had no inline visibility to empty', () => {
    setup('<header id="h" style="position: fixed">nav</header>')
    hideFixedElements(document)
    restoreFixedElements(document)
    expect(document.querySelector<HTMLElement>('#h')!.style.visibility).toBe('')
  })

  it('is idempotent when restore runs without hide', () => {
    setup('<header id="h" style="position: fixed">nav</header>')
    expect(() => restoreFixedElements(document)).not.toThrow()
    expect(document.querySelector<HTMLElement>('#h')!.style.visibility).toBe('')
  })

  it('is idempotent when restore runs twice', () => {
    setup('<header id="h" style="position: fixed; visibility: visible">nav</header>')
    hideFixedElements(document)
    restoreFixedElements(document)
    restoreFixedElements(document)
    expect(document.querySelector<HTMLElement>('#h')!.style.visibility).toBe('visible')
  })
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm vitest run tests/content/fixed-elements.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/content/fixed-elements"`.

- [ ] **Step 5: Write `src/content/fixed-elements.ts`**

```ts
const MARKER = 'data-fps-prev-visibility'

/**
 * Hides fixed and sticky elements so they are not repeated on every frame.
 * The previous inline value is stored on the element itself, so restore
 * works even if this module is re-injected.
 */
export function hideFixedElements(doc: Document): void {
  for (const element of doc.querySelectorAll<HTMLElement>('body *')) {
    if (element.hasAttribute(MARKER)) continue
    const position = doc.defaultView?.getComputedStyle(element).position
    if (position !== 'fixed' && position !== 'sticky') continue
    element.setAttribute(MARKER, element.style.visibility)
    element.style.visibility = 'hidden'
  }
}

export function restoreFixedElements(doc: Document): void {
  for (const element of doc.querySelectorAll<HTMLElement>(`[${MARKER}]`)) {
    element.style.visibility = element.getAttribute(MARKER) ?? ''
    element.removeAttribute(MARKER)
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run tests/content/fixed-elements.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add src/shared src/content tests/content
git commit -m "feat(content): hide and restore fixed elements idempotently"
```

---

### Task 5: Scroll driver and the content script entry point

**Files:**
- Create: `src/content/scroll-driver.ts`, `src/content/index.ts`
- Test: `tests/content/scroll-driver.test.ts`

**Interfaces:**
- Consumes: `hideFixedElements`, `restoreFixedElements` from Task 4; `ContentRequest`, `ContentResponse` from Task 4; `PageMeasurements` from Task 2
- Produces:
  - `function measurePage(win: Window): PageMeasurements`
  - `function scrollToStep(win: Window, y: number): Promise<void>`
  - a `chrome.runtime.onMessage` listener in `src/content/index.ts` handling every `ContentRequest`

`scrollToStep` waits two animation frames plus a short settle delay after scrolling. Two frames let the browser paint the new position; the settle delay gives lazy-loaded images a chance to swap in. This is a heuristic, and Task 9's lazy-load fixture is what proves whether the delay is long enough.

- [ ] **Step 1: Write the failing tests**

`tests/content/scroll-driver.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { measurePage, scrollToStep } from '../../src/content/scroll-driver'

describe('measurePage', () => {
  it('reads dimensions from the document and window', () => {
    document.body.innerHTML = '<div style="height: 3000px"></div>'
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 3000,
      configurable: true,
    })
    const m = measurePage(window)
    expect(m.scrollHeight).toBe(3000)
    expect(m.viewportWidth).toBe(window.innerWidth)
    expect(m.viewportHeight).toBe(window.innerHeight)
    expect(m.devicePixelRatio).toBe(window.devicePixelRatio)
  })
})

describe('scrollToStep', () => {
  it('scrolls the window to the requested offset', async () => {
    const scrollTo = vi.fn()
    const win = {
      scrollTo,
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        cb(0)
        return 0
      },
      setTimeout: (cb: () => void) => {
        cb()
        return 0
      },
    } as unknown as Window

    await scrollToStep(win, 1600)
    expect(scrollTo).toHaveBeenCalledWith({ top: 1600, left: 0, behavior: 'instant' })
  })

  it('resolves only after the frames and the settle delay', async () => {
    const order: string[] = []
    const win = {
      scrollTo: () => order.push('scroll'),
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        order.push('frame')
        cb(0)
        return 0
      },
      setTimeout: (cb: () => void) => {
        order.push('settle')
        cb()
        return 0
      },
    } as unknown as Window

    await scrollToStep(win, 100)
    expect(order).toEqual(['scroll', 'frame', 'frame', 'settle'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/content/scroll-driver.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/content/scroll-driver"`.

- [ ] **Step 3: Write `src/content/scroll-driver.ts`**

```ts
import type { PageMeasurements } from '../core/types'

/** Milliseconds to wait after painting, for lazy-loaded content to swap in. */
export const SETTLE_DELAY_MS = 120

export function measurePage(win: Window): PageMeasurements {
  const doc = win.document.documentElement
  return {
    scrollWidth: doc.scrollWidth,
    scrollHeight: doc.scrollHeight,
    viewportWidth: win.innerWidth,
    viewportHeight: win.innerHeight,
    devicePixelRatio: win.devicePixelRatio,
    scrollX: win.scrollX,
    scrollY: win.scrollY,
  }
}

function nextFrame(win: Window): Promise<void> {
  return new Promise((resolve) => win.requestAnimationFrame(() => resolve()))
}

export async function scrollToStep(win: Window, y: number): Promise<void> {
  win.scrollTo({ top: y, left: 0, behavior: 'instant' as ScrollBehavior })
  await nextFrame(win)
  await nextFrame(win)
  await new Promise<void>((resolve) => win.setTimeout(resolve, SETTLE_DELAY_MS))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/content/scroll-driver.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write `src/content/index.ts`**

```ts
import type { ContentRequest, ContentResponse } from '../shared/messages'
import { hideFixedElements, restoreFixedElements } from './fixed-elements'
import { measurePage, scrollToStep } from './scroll-driver'

let originalScrollY: number | null = null

async function handle(request: ContentRequest): Promise<ContentResponse> {
  switch (request.type) {
    case 'measure': {
      const measurements = measurePage(window)
      originalScrollY = measurements.scrollY
      return { ok: true, measurements }
    }
    case 'hideFixed':
      hideFixedElements(document)
      return { ok: true }
    case 'scrollTo':
      await scrollToStep(window, request.y)
      return { ok: true }
    case 'restore':
      restoreFixedElements(document)
      if (originalScrollY !== null) {
        window.scrollTo({ top: originalScrollY, left: 0, behavior: 'instant' as ScrollBehavior })
        originalScrollY = null
      }
      return { ok: true }
  }
}

chrome.runtime.onMessage.addListener((request: ContentRequest, _sender, sendResponse) => {
  handle(request)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({ ok: false, error: String(error) } satisfies ContentResponse)
    })
  return true
})
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/content tests/content
git commit -m "feat(content): add scroll driver and message handler"
```

---

### Task 6: Offscreen document — stitching and sinks

**Files:**
- Create: `src/offscreen/offscreen.html`, `src/offscreen/stitcher.ts`, `src/offscreen/sinks.ts`, `src/offscreen/index.ts`
- Modify: `src/manifest.config.ts` (add `web_accessible_resources` is not needed; add the offscreen page to the build inputs)
- Test: covered end-to-end in Task 9 — the canvas work needs a real browser

**Interfaces:**
- Consumes: `OffscreenRequest`, `OffscreenResponse` from Task 4
- Produces:
  - `class Stitcher { constructor(width: number, height: number); addFrame(dataUrl: string, destY: number, sourceHeight: number): Promise<void>; toBlob(): Promise<Blob> }`
  - `function copyToClipboard(blob: Blob): Promise<void>`
  - `function downloadBlob(blob: Blob, filename: string): Promise<void>`

The offscreen document owns the canvas because it is the only context with a DOM, and it is already required for clipboard writes. `Stitcher` holds the canvas across messages — the service worker sends frames one at a time.

- [ ] **Step 1: Write `src/offscreen/offscreen.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Full Page Shot worker</title>
  </head>
  <body>
    <script type="module" src="./index.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `src/offscreen/stitcher.ts`**

```ts
export class Stitcher {
  private readonly canvas: OffscreenCanvas
  private readonly context: OffscreenCanvasRenderingContext2D

  constructor(width: number, height: number) {
    this.canvas = new OffscreenCanvas(width, height)
    const context = this.canvas.getContext('2d')
    if (!context) throw new Error('2d context unavailable')
    this.context = context
  }

  async addFrame(dataUrl: string, destY: number, sourceHeight: number): Promise<void> {
    const response = await fetch(dataUrl)
    const bitmap = await createImageBitmap(await response.blob())
    try {
      this.context.drawImage(
        bitmap,
        0,
        0,
        bitmap.width,
        Math.min(sourceHeight, bitmap.height),
        0,
        destY,
        bitmap.width,
        Math.min(sourceHeight, bitmap.height),
      )
    } finally {
      bitmap.close()
    }
  }

  toBlob(): Promise<Blob> {
    return this.canvas.convertToBlob({ type: 'image/png' })
  }
}
```

- [ ] **Step 3: Write `src/offscreen/sinks.ts`**

```ts
export async function copyToClipboard(blob: Blob): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob)
  try {
    await chrome.downloads.download({ url, filename, saveAs: false })
  } finally {
    // The download reads the blob asynchronously; revoking immediately can
    // abort it, so give Chrome a moment to take ownership of the URL.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}
```

- [ ] **Step 4: Write `src/offscreen/index.ts`**

```ts
import type { OffscreenRequest, OffscreenResponse } from '../shared/messages'
import { copyToClipboard, downloadBlob } from './sinks'
import { Stitcher } from './stitcher'

let stitcher: Stitcher | null = null

async function handle(request: OffscreenRequest): Promise<OffscreenResponse> {
  switch (request.type) {
    case 'beginCapture':
      stitcher = new Stitcher(request.width, request.height)
      return { ok: true }
    case 'addFrame':
      if (!stitcher) return { ok: false, error: 'no capture in progress' }
      await stitcher.addFrame(request.dataUrl, request.destY, request.sourceHeight)
      return { ok: true }
    case 'finishCapture': {
      if (!stitcher) return { ok: false, error: 'no capture in progress' }
      try {
        const blob = await stitcher.toBlob()
        if (request.toClipboard) await copyToClipboard(blob)
        if (request.toDownload) await downloadBlob(blob, request.filename)
        return { ok: true }
      } finally {
        stitcher = null
      }
    }
    case 'abortCapture':
      stitcher = null
      return { ok: true }
  }
}

chrome.runtime.onMessage.addListener((request: OffscreenRequest, _sender, sendResponse) => {
  if (!('type' in request)) return false
  handle(request)
    .then(sendResponse)
    .catch((error: unknown) => {
      stitcher = null
      sendResponse({ ok: false, error: String(error) } satisfies OffscreenResponse)
    })
  return true
})
```

- [ ] **Step 5: Verify the build picks up the offscreen page**

Run: `pnpm build && ls dist/src/offscreen`
Expected: `offscreen.html` present in `dist/`. If CRXJS did not emit it, add it explicitly to `build.rollupOptions.input` in `vite.config.ts`:

```ts
  build: {
    target: 'esnext',
    rollupOptions: { input: { offscreen: 'src/offscreen/offscreen.html' } },
  },
```

- [ ] **Step 6: Commit**

```bash
git add src/offscreen vite.config.ts
git commit -m "feat(offscreen): stitch frames to canvas and deliver to sinks"
```

---

### Task 7: Preferences and the capture orchestrator

**Files:**
- Create: `src/shared/prefs.ts`, `src/background/capture-loop.ts`
- Modify: `src/background/index.ts`
- Test: `tests/shared/prefs.test.ts`, `tests/background/capture-loop.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6
- Produces:
  - `interface Prefs { toClipboard: boolean; toDownload: boolean }`
  - `const DEFAULT_PREFS: Prefs`
  - `function loadPrefs(): Promise<Prefs>`, `function savePrefs(prefs: Prefs): Promise<void>`
  - `function isCapturableUrl(url: string | undefined): boolean`
  - `function buildFilename(now: Date, hostname: string): string`
  - `function runCapture(tabId: number, deps: CaptureDeps): Promise<void>`

`runCapture` takes its Chrome dependencies as an argument so it can be unit-tested with fakes. That is the whole reason this task's orchestration is testable at all — everything it touches is injected.

- [ ] **Step 1: Write the failing prefs tests**

`tests/shared/prefs.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFS, buildFilename, isCapturableUrl } from '../../src/shared/prefs'

describe('DEFAULT_PREFS', () => {
  it('downloads and copies by default', () => {
    expect(DEFAULT_PREFS).toEqual({ toClipboard: true, toDownload: true })
  })
})

describe('isCapturableUrl', () => {
  it('accepts http and https pages', () => {
    expect(isCapturableUrl('https://example.com')).toBe(true)
    expect(isCapturableUrl('http://example.com')).toBe(true)
  })

  it.each([
    'chrome://extensions',
    'chrome-extension://abc/page.html',
    'https://chromewebstore.google.com/detail/x',
    'https://chrome.google.com/webstore/detail/x',
    'devtools://devtools/bundled/x.html',
    'about:blank',
    'file:///Users/me/doc.pdf',
  ])('rejects %s', (url) => {
    expect(isCapturableUrl(url)).toBe(false)
  })

  it('rejects an undefined url', () => {
    expect(isCapturableUrl(undefined)).toBe(false)
  })
})

describe('buildFilename', () => {
  it('includes the hostname and a sortable timestamp', () => {
    const name = buildFilename(new Date('2026-09-01T14:05:09Z'), 'example.com')
    expect(name).toBe('full-page-shot/example.com-2026-09-01T14-05-09.png')
  })

  it('sanitises a hostname with characters illegal in filenames', () => {
    const name = buildFilename(new Date('2026-09-01T00:00:00Z'), 'sub.example.com:8443')
    expect(name).toBe('full-page-shot/sub.example.com-8443-2026-09-01T00-00-00.png')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/shared/prefs.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/shared/prefs"`.

- [ ] **Step 3: Write `src/shared/prefs.ts`**

```ts
export interface Prefs {
  toClipboard: boolean
  toDownload: boolean
}

export const DEFAULT_PREFS: Prefs = { toClipboard: true, toDownload: true }

const BLOCKED_PREFIXES = ['chrome://', 'chrome-extension://', 'devtools://', 'about:', 'file://']
const BLOCKED_HOSTS = ['chromewebstore.google.com', 'chrome.google.com']

export function isCapturableUrl(url: string | undefined): boolean {
  if (!url) return false
  if (BLOCKED_PREFIXES.some((prefix) => url.startsWith(prefix))) return false
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return !BLOCKED_HOSTS.includes(parsed.hostname)
  } catch {
    return false
  }
}

export function buildFilename(now: Date, hostname: string): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-')
  const safeHost = hostname.replace(/[^a-zA-Z0-9.-]/g, '-')
  return `full-page-shot/${safeHost}-${stamp}.png`
}

export async function loadPrefs(): Promise<Prefs> {
  const stored = await chrome.storage.sync.get(DEFAULT_PREFS)
  return { toClipboard: !!stored.toClipboard, toDownload: !!stored.toDownload }
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  await chrome.storage.sync.set(prefs)
}
```

`loadPrefs` and `savePrefs` use `chrome.storage.sync`, which the `storage` permission already granted in Task 1 covers.

- [ ] **Step 4: Run the prefs tests to verify they pass**

Run: `pnpm vitest run tests/shared/prefs.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Write the failing capture-loop test**

`tests/background/capture-loop.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { runCapture } from '../../src/background/capture-loop'
import type { CaptureDeps } from '../../src/background/capture-loop'
import type { ContentRequest } from '../../src/shared/messages'
import type { PageMeasurements } from '../../src/core/types'

const measurements: PageMeasurements = {
  scrollWidth: 1000,
  scrollHeight: 2000,
  viewportWidth: 1000,
  viewportHeight: 800,
  devicePixelRatio: 1,
  scrollX: 0,
  scrollY: 0,
}

function makeDeps(overrides: Partial<CaptureDeps> = {}) {
  const contentCalls: ContentRequest[] = []
  const offscreenCalls: string[] = []
  const deps: CaptureDeps = {
    sendToContent: vi.fn(async (_tabId: number, request: ContentRequest) => {
      contentCalls.push(request)
      return request.type === 'measure'
        ? { ok: true as const, measurements }
        : { ok: true as const }
    }),
    sendToOffscreen: vi.fn(async (request: { type: string }) => {
      offscreenCalls.push(request.type)
      return { ok: true as const }
    }),
    captureVisibleTab: vi.fn(async () => 'data:image/png;base64,AAAA'),
    ensureOffscreen: vi.fn(async () => {}),
    isTabStillActive: vi.fn(async () => true),
    prefs: { toClipboard: true, toDownload: true },
    filename: 'full-page-shot/example.com-2026-09-01T00-00-00.png',
    delay: vi.fn(async () => {}),
    ...overrides,
  }
  return { deps, contentCalls, offscreenCalls }
}

describe('runCapture', () => {
  it('captures one frame per planned step', async () => {
    const { deps } = makeDeps()
    await runCapture(1, deps)
    expect(deps.captureVisibleTab).toHaveBeenCalledTimes(3)
  })

  it('captures frame 0 with fixed elements still visible, then hides them', async () => {
    // Ordering matters and a weaker assertion missed a real bug: the header must
    // still be on screen when frame 0 is captured, and gone for every frame after.
    const timeline: string[] = []
    const { deps } = makeDeps({
      sendToContent: vi.fn(async (_tabId: number, request: ContentRequest) => {
        timeline.push(request.type)
        return request.type === 'measure'
          ? { ok: true as const, measurements }
          : { ok: true as const }
      }),
      captureVisibleTab: vi.fn(async () => {
        timeline.push('capture')
        return 'data:image/png;base64,AAAA'
      }),
    })

    await runCapture(1, deps)

    expect(timeline.indexOf('hideFixed')).toBeGreaterThan(timeline.indexOf('capture'))
    expect(timeline.filter((t) => t === 'hideFixed')).toHaveLength(1)
  })

  it('streams each frame instead of batching them', async () => {
    const { deps, offscreenCalls } = makeDeps()
    await runCapture(1, deps)
    expect(offscreenCalls.filter((t) => t === 'addFrame')).toHaveLength(3)
    expect(offscreenCalls[0]).toBe('beginCapture')
    expect(offscreenCalls.at(-1)).toBe('finishCapture')
  })

  it('restores the page even when a capture call throws', async () => {
    const { deps, contentCalls } = makeDeps({
      captureVisibleTab: vi.fn(async () => {
        throw new Error('rate limited')
      }),
    })
    await expect(runCapture(1, deps)).rejects.toThrow('rate limited')
    expect(contentCalls.at(-1)?.type).toBe('restore')
  })

  it('aborts the offscreen canvas when the capture fails', async () => {
    const { deps, offscreenCalls } = makeDeps({
      captureVisibleTab: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    await expect(runCapture(1, deps)).rejects.toThrow('boom')
    expect(offscreenCalls).toContain('abortCapture')
    expect(offscreenCalls).not.toContain('finishCapture')
  })

  it('throttles between captures', async () => {
    const { deps } = makeDeps()
    await runCapture(1, deps)
    expect(deps.delay).toHaveBeenCalled()
  })

  it('aborts when the user switches away from the tab mid-capture', async () => {
    let calls = 0
    const { deps, contentCalls, offscreenCalls } = makeDeps({
      isTabStillActive: vi.fn(async () => {
        calls += 1
        return calls < 2
      }),
    })

    await expect(runCapture(1, deps)).rejects.toThrow(/no longer active/i)
    expect(deps.captureVisibleTab).toHaveBeenCalledTimes(1)
    expect(offscreenCalls).toContain('abortCapture')
    expect(contentCalls.at(-1)?.type).toBe('restore')
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm vitest run tests/background/capture-loop.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/background/capture-loop"`.

- [ ] **Step 7: Write `src/background/capture-loop.ts`**

```ts
import { planCapture } from '../core/page-metrics'
import { computeFramePlacements } from '../core/stitch-plan'
import type { ContentRequest, ContentResponse, OffscreenRequest, OffscreenResponse } from '../shared/messages'
import type { Prefs } from '../shared/prefs'

/** captureVisibleTab is quota-limited; this spacing keeps the loop under it. */
export const CAPTURE_INTERVAL_MS = 550

export interface CaptureDeps {
  sendToContent: (tabId: number, request: ContentRequest) => Promise<ContentResponse>
  sendToOffscreen: (request: OffscreenRequest) => Promise<OffscreenResponse>
  captureVisibleTab: () => Promise<string>
  ensureOffscreen: () => Promise<void>
  /** False once the user has switched tabs or windows — the capture must stop. */
  isTabStillActive: () => Promise<boolean>
  prefs: Prefs
  filename: string
  delay: (ms: number) => Promise<void>
}

function unwrap(response: ContentResponse | OffscreenResponse): void {
  if (!response.ok) throw new Error(response.error)
}

export async function runCapture(tabId: number, deps: CaptureDeps): Promise<void> {
  const measured = await deps.sendToContent(tabId, { type: 'measure' })
  unwrap(measured)
  const measurements = measured.ok ? measured.measurements : undefined
  if (!measurements) throw new Error('page measurement failed')

  const plan = planCapture(measurements)
  const placements = computeFramePlacements(plan, measurements)

  await deps.ensureOffscreen()
  let began = false

  try {
    unwrap(
      await deps.sendToOffscreen({
        type: 'beginCapture',
        width: plan.canvasWidth,
        height: plan.canvasHeight,
      }),
    )
    began = true

    for (const [i, step] of plan.steps.entries()) {
      const placement = placements[i]
      if (!placement) throw new Error(`missing placement for step ${i}`)

      unwrap(await deps.sendToContent(tabId, { type: 'scrollTo', y: step.scrollY }))

      // Fixed headers belong in frame 0 and nowhere else. Hide them from frame 1
      // onward — hiding at i === 0 would strip the header from the whole image,
      // which is the opposite of the intent.
      if (i === 1) unwrap(await deps.sendToContent(tabId, { type: 'hideFixed' }))

      if (i > 0) await deps.delay(CAPTURE_INTERVAL_MS)

      // captureVisibleTab grabs whatever is on screen. If the user switched
      // tabs, the next frame would be someone else's page — stop instead.
      if (!(await deps.isTabStillActive())) {
        throw new Error('tab is no longer active')
      }

      const dataUrl = await deps.captureVisibleTab()

      unwrap(
        await deps.sendToOffscreen({
          type: 'addFrame',
          dataUrl,
          destY: placement.destY,
          sourceHeight: placement.sourceHeight,
        }),
      )
    }

    unwrap(
      await deps.sendToOffscreen({
        type: 'finishCapture',
        toClipboard: deps.prefs.toClipboard,
        toDownload: deps.prefs.toDownload,
        filename: deps.filename,
      }),
    )
    began = false
  } catch (error) {
    if (began) await deps.sendToOffscreen({ type: 'abortCapture' }).catch(() => {})
    throw error
  } finally {
    // The page must never be left scrolled or with a hidden header.
    await deps.sendToContent(tabId, { type: 'restore' }).catch(() => {})
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm vitest run tests/background/capture-loop.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 9: Wire the real service worker**

`src/background/index.ts`:

```ts
import { runCapture } from './capture-loop'
import { buildFilename, isCapturableUrl, loadPrefs } from '../shared/prefs'
import type { ContentRequest, ContentResponse, OffscreenRequest, OffscreenResponse } from '../shared/messages'

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html'

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  })
  if (existing.length > 0) return
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.CLIPBOARD],
    justification: 'Stitch captured frames into a single image and copy it to the clipboard.',
  })
}

async function setBadge(tabId: number, text: string, color: string): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ tabId, color })
  await chrome.action.setBadgeText({ tabId, text })
  setTimeout(() => void chrome.action.setBadgeText({ tabId, text: '' }), 3000)
}

chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    if (tab.id === undefined) return
    if (!isCapturableUrl(tab.url)) {
      await setBadge(tab.id, '✕', '#b3261e')
      return
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [contentScriptPath()],
      })

      await runCapture(tab.id, {
        sendToContent: (tabId, request: ContentRequest) =>
          chrome.tabs.sendMessage(tabId, request) as Promise<ContentResponse>,
        sendToOffscreen: (request: OffscreenRequest) =>
          chrome.runtime.sendMessage(request) as Promise<OffscreenResponse>,
        captureVisibleTab: () =>
          chrome.tabs.captureVisibleTab({ format: 'png' }),
        ensureOffscreen,
        isTabStillActive: async () => {
          const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
          return active?.id === tab.id
        },
        prefs: await loadPrefs(),
        filename: buildFilename(new Date(), new URL(tab.url!).hostname),
        delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      })

      await setBadge(tab.id, '✓', '#1e8e3e')
    } catch (error) {
      console.error('[full-page-shot]', error)
      await setBadge(tab.id, '✕', '#b3261e')
    }
  })()
})
```

**Never hardcode the injected path.** CRXJS hashes output filenames, so a literal
like `src/content/index.ts.js` is wrong today and would break again on the next
build. Read the resolved path out of the manifest at runtime instead — add this
helper to `src/background/index.ts`:

```ts
/**
 * CRXJS rewrites web_accessible_resources to the real hashed output path, so the
 * manifest is the only reliable source for what to inject.
 */
function contentScriptPath(): string {
  for (const entry of chrome.runtime.getManifest().web_accessible_resources ?? []) {
    if (typeof entry === 'object' && 'resources' in entry) {
      const hit = entry.resources?.find((r) => r.includes('content'))
      if (hit) return hit
    }
  }
  throw new Error('content script missing from web_accessible_resources')
}
```

Verify after building that `dist/manifest.json` really lists the emitted content
script under `web_accessible_resources`, and that the file it names exists.

- [ ] **Step 10: Build, reload, and capture a real page**

Run: `pnpm build`, reload the unpacked extension, open a long article, click the icon. Confirm: a PNG lands in `~/Downloads/full-page-shot/`, the image shows the whole page, the header appears once at the top, and the page is back at its original scroll position.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(background): orchestrate full-page capture end to end"
```

---

### Task 8: Options page

**Files:**
- Create: `src/options/options.html`, `src/options/main.tsx`, `src/options/App.tsx`
- Modify: `src/manifest.config.ts` (add `options_page`), `vite.config.ts` (add the React plugin)
- Test: `tests/options/App.test.tsx`

**Interfaces:**
- Consumes: `Prefs`, `DEFAULT_PREFS`, `loadPrefs`, `savePrefs` from Task 7
- Produces: `function App(props: { load: () => Promise<Prefs>; save: (p: Prefs) => Promise<void> }): JSX.Element`

`App` takes its persistence as props so the test never needs a Chrome API stub.

- [ ] **Step 1: Install the React toolchain**

```bash
pnpm add react@19.2.8 react-dom@19.2.8
pnpm add -D @vitejs/plugin-react@6.1.1 @testing-library/react @testing-library/user-event @testing-library/jest-dom
```

- [ ] **Step 2: Register the React plugin in `vite.config.ts`**

```ts
import react from '@vitejs/plugin-react'
// ...
  plugins: [react(), crx({ manifest })],
```

And extend the jsdom project to cover the options tests, remembering to exclude them from the node project too:

```ts
      {
        extends: true,
        test: {
          name: 'jsdom',
          include: ['tests/content/**', 'tests/options/**'],
          environment: 'jsdom',
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          include: ['tests/**'],
          exclude: ['tests/content/**', 'tests/options/**'],
        },
      },
```

- [ ] **Step 3: Write the failing test**

`tests/options/App.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../src/options/App'

describe('options App', () => {
  it('renders the stored preferences', async () => {
    const load = vi.fn(async () => ({ toClipboard: false, toDownload: true }))
    render(<App load={load} save={vi.fn(async () => {})} />)

    const clipboard = await screen.findByLabelText(/clipboard/i)
    const download = await screen.findByLabelText(/download/i)
    expect(clipboard).not.toBeChecked()
    expect(download).toBeChecked()
  })

  it('saves when a preference is toggled', async () => {
    const save = vi.fn(async () => {})
    render(<App load={async () => ({ toClipboard: false, toDownload: true })} save={save} />)

    await userEvent.click(await screen.findByLabelText(/clipboard/i))
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith({ toClipboard: true, toDownload: true })
    })
  })

  it('warns when both outputs are off', async () => {
    render(<App load={async () => ({ toClipboard: false, toDownload: false })} save={vi.fn(async () => {})} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least one/i)
  })
})
```

Add `import '@testing-library/jest-dom/vitest'` to a `tests/setup.ts` and register it via `test.setupFiles: ['tests/setup.ts']` in `vite.config.ts`.

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run tests/options/App.test.tsx`
Expected: FAIL — `Failed to resolve import "../../src/options/App"`.

- [ ] **Step 5: Write `src/options/App.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { Prefs } from '../shared/prefs'

interface Props {
  load: () => Promise<Prefs>
  save: (prefs: Prefs) => Promise<void>
}

export function App({ load, save }: Props) {
  const [prefs, setPrefs] = useState<Prefs | null>(null)

  useEffect(() => {
    void load().then(setPrefs)
  }, [load])

  if (!prefs) return <p>Loading…</p>

  const update = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    void save(next)
  }

  return (
    <main>
      <h1>Full Page Shot</h1>
      <p>What happens after a capture:</p>

      <label>
        <input
          type="checkbox"
          checked={prefs.toClipboard}
          onChange={(e) => update({ toClipboard: e.target.checked })}
        />
        Copy to clipboard
      </label>

      <label>
        <input
          type="checkbox"
          checked={prefs.toDownload}
          onChange={(e) => update({ toDownload: e.target.checked })}
        />
        Save as a PNG download
      </label>

      {!prefs.toClipboard && !prefs.toDownload && (
        <p role="alert">Pick at least one output, or the capture goes nowhere.</p>
      )}
    </main>
  )
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run tests/options/App.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 7: Write the entry point and HTML**

`src/options/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { loadPrefs, savePrefs } from '../shared/prefs'

const root = document.getElementById('root')
if (root) createRoot(root).render(<App load={loadPrefs} save={savePrefs} />)
```

`src/options/options.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Full Page Shot — Options</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

Add to `src/manifest.config.ts`:

```ts
  options_page: 'src/options/options.html',
```

- [ ] **Step 8: Build and verify in Chrome**

Run: `pnpm build`, reload the extension, open its options from `chrome://extensions`. Toggle a checkbox, reload the page, confirm the choice persisted.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(options): add output preferences page"
```

---

### Task 9: End-to-end tests with Playwright

**Files:**
- Create: `playwright.config.ts`, `e2e/fixtures/short.html`, `e2e/fixtures/long-fixed-header.html`, `e2e/fixtures/lazy-images.html`, `e2e/fixtures/non-multiple.html`, `e2e/capture.spec.ts`
- Modify: `package.json` (add the `test:e2e` script), `src/shared/messages.ts` (add `measureCapture`), `src/offscreen/stitcher.ts` (add the `size` getter), `src/offscreen/index.ts` (handle `measureCapture`), `src/background/index.ts` (add the test hook)

**Interfaces:**
- Consumes: the built extension in `dist/`
- Produces: nothing consumed by later tasks

This is the layer that proves the capture is visually correct. The unit tests prove the arithmetic; only a real browser proves the image.

- [ ] **Step 1: Install Playwright**

```bash
pnpm add -D @playwright/test@1.62.1
pnpm exec playwright install chromium
```

- [ ] **Step 2: Write the fixtures**

`e2e/fixtures/short.html` — content shorter than one viewport:

```html
<!doctype html>
<html><body style="margin:0">
  <div style="height:300px;background:linear-gradient(#f00,#00f)">short</div>
</body></html>
```

`e2e/fixtures/long-fixed-header.html` — the duplication trap:

```html
<!doctype html>
<html><body style="margin:0">
  <header id="hdr" style="position:fixed;top:0;left:0;right:0;height:60px;background:#000;color:#fff">HEADER</header>
  <div style="height:4000px;background:repeating-linear-gradient(#fff 0 100px,#ccc 100px 200px)"></div>
</body></html>
```

`e2e/fixtures/lazy-images.html` — content that appears only after scrolling:

```html
<!doctype html>
<html><body style="margin:0">
  <div style="height:2500px"></div>
  <img id="lazy" loading="lazy" width="400" height="300"
       src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect width='400' height='300' fill='%2300ff00'/%3E%3C/svg%3E" />
  <div style="height:1000px"></div>
</body></html>
```

`e2e/fixtures/non-multiple.html` — height deliberately not a multiple of the viewport:

```html
<!doctype html>
<html><body style="margin:0">
  <div style="height:1731px;background:linear-gradient(#000,#fff)"></div>
  <div id="bottom" style="height:40px;background:#ff00ff"></div>
</body></html>
```

- [ ] **Step 3: Write `playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: { viewport: { width: 1280, height: 720 } },
  webServer: {
    command: 'pnpm exec vite preview --outDir e2e/fixtures --port 5199 --strictPort',
    url: 'http://localhost:5199/short.html',
    reuseExistingServer: true,
  },
})
```

If `vite preview` refuses to serve a plain directory, substitute any static server, e.g. `pnpm dlx serve e2e/fixtures -l 5199`.

- [ ] **Step 4: Write `e2e/capture.spec.ts`**

```ts
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, chromium, type BrowserContext, type Worker } from '@playwright/test'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dirname, '../dist')
const BASE = 'http://localhost:5199'

let context: BrowserContext
let worker: Worker

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
})

test.afterAll(async () => {
  await context.close()
})

/**
 * Drives a capture from inside the service worker and returns the stitched
 * PNG as a data URL, without going through the download or clipboard sinks.
 */
async function capture(url: string): Promise<{ width: number; height: number }> {
  const page = await context.newPage()
  await page.goto(url)
  await page.waitForLoadState('networkidle')

  const result = await worker.evaluate(async () => {
    // @ts-expect-error injected test hook
    return await globalThis.__fpsCaptureForTest()
  })

  await page.close()
  return result as { width: number; height: number }
}

test('captures a page shorter than the viewport in one frame', async () => {
  const shot = await capture(`${BASE}/short.html`)
  expect(shot.height).toBeLessThanOrEqual(720)
})

test('captures the full height of a long page', async () => {
  const shot = await capture(`${BASE}/long-fixed-header.html`)
  expect(shot.height).toBeGreaterThan(4000)
})

test('restores scroll position and the fixed header after capturing', async () => {
  const page = await context.newPage()
  await page.goto(`${BASE}/long-fixed-header.html`)
  await page.evaluate(() => window.scrollTo(0, 500))
  await worker.evaluate(async () => {
    // @ts-expect-error injected test hook
    await globalThis.__fpsCaptureForTest()
  })
  expect(await page.evaluate(() => window.scrollY)).toBe(500)
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#hdr')!).visibility)).toBe('visible')
  await page.close()
})

test('captures the bottom of a page whose height is not a viewport multiple', async () => {
  const shot = await capture(`${BASE}/non-multiple.html`)
  expect(shot.height).toBeGreaterThanOrEqual(1771)
})

test('includes lazily-loaded content', async () => {
  const shot = await capture(`${BASE}/lazy-images.html`)
  expect(shot.height).toBeGreaterThan(3500)
})
```

- [ ] **Step 5: Teach the offscreen document to report dimensions instead of delivering**

The E2E suite needs the stitched image's size without writing to the clipboard or the downloads folder. Add a variant that measures and discards.

In `src/shared/messages.ts`, extend the two offscreen types:

```ts
export type OffscreenRequest =
  | { type: 'beginCapture'; width: number; height: number }
  | { type: 'addFrame'; dataUrl: string; destY: number; sourceHeight: number }
  | { type: 'finishCapture'; toClipboard: boolean; toDownload: boolean; filename: string }
  | { type: 'measureCapture' }
  | { type: 'abortCapture' }

export type OffscreenResponse =
  | { ok: true }
  | { ok: true; width: number; height: number }
  | { ok: false; error: string }
```

In `src/offscreen/stitcher.ts`, expose the canvas size:

```ts
  get size(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height }
  }
```

In `src/offscreen/index.ts`, add the case before `abortCapture`:

```ts
    case 'measureCapture': {
      if (!stitcher) return { ok: false, error: 'no capture in progress' }
      const { width, height } = stitcher.size
      stitcher = null
      return { ok: true, width, height }
    }
```

- [ ] **Step 6: Add the test hook to the service worker**

Append to `src/background/index.ts`:

```ts
// Test-only hook, used by the Playwright suite. The production build strips
// it, so it can never fire for a real user.
if (import.meta.env.MODE !== 'production') {
  Object.assign(globalThis, {
    __fpsCaptureForTest: async (): Promise<{ width: number; height: number }> => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.id === undefined || !tab.url) throw new Error('no active tab')

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [contentScriptPath()],
      })

      let measured: { width: number; height: number } = { width: 0, height: 0 }

      await runCapture(tab.id, {
        sendToContent: (tabId, request) =>
          chrome.tabs.sendMessage(tabId, request) as Promise<ContentResponse>,
        sendToOffscreen: async (request: OffscreenRequest) => {
          // Swap the delivering finish for the measuring one.
          const outbound: OffscreenRequest =
            request.type === 'finishCapture' ? { type: 'measureCapture' } : request
          const response = (await chrome.runtime.sendMessage(outbound)) as OffscreenResponse
          if (response.ok && 'width' in response) {
            measured = { width: response.width, height: response.height }
          }
          return response
        },
        captureVisibleTab: () => chrome.tabs.captureVisibleTab({ format: 'png' }),
        ensureOffscreen,
        isTabStillActive: async () => true,
        prefs: { toClipboard: false, toDownload: false },
        filename: 'unused-in-test.png',
        delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      })

      return measured
    },
  })
}
```

`isTabStillActive` returns `true` unconditionally here: Playwright drives the browser through the DevTools protocol, and the active-tab check is unreliable under automation. The real listener in production keeps the real check.

- [ ] **Step 7: Add the script and run the suite**

```json
    "test:e2e": "pnpm build && playwright test"
```

Run: `pnpm test:e2e`
Expected: 5 tests PASS. If the lazy-load test fails, raise `SETTLE_DELAY_MS` in `src/content/scroll-driver.ts` — this test exists precisely to calibrate that constant.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "test(e2e): verify capture against fixture pages in real Chromium"
```

---

### Task 10: Continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`
- Modify: `package.json` (add a `lint` script)

**Interfaces:**
- Consumes: the `test`, `typecheck`, `build`, `test:e2e` scripts
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Add linting**

```bash
pnpm add -D oxlint
```

Add to `package.json`:

```json
    "lint": "oxlint src tests e2e"
```

Run: `pnpm lint` and fix whatever it reports.

- [ ] **Step 2: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test -- --coverage
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm test:e2e
      - uses: codecov/codecov-action@v5
        with:
          files: ./coverage/lcov.info
          token: ${{ secrets.CODECOV_TOKEN }}
```

- [ ] **Step 3: Write `README.md`**

Cover: what the extension does, why scroll-and-stitch was chosen over `chrome.debugger` (link the spec), how to develop (`pnpm dev`, load `dist/` unpacked), how to run each test layer, and the CI/coverage badges.

- [ ] **Step 4: Push and confirm CI is green**

```bash
gh repo create raniellimontagna/full-page-shot --public --source=. --remote=origin --push
gh run watch
```

Expected: the workflow passes. If the E2E job fails on the runner but passes locally, add `xvfb-run` to the Playwright step — headed Chromium extensions need a display server.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "ci: add lint, typecheck, unit and e2e pipeline with coverage"
git push
```

---

### Task 11: Store submission assets

**Files:**
- Create: `docs/store/privacy-policy.md`, `docs/store/listing.md`, `store/screenshots/` (5 PNGs at 1280×800)
- Modify: `public/icons/*.png` (real artwork), `src/manifest.config.ts` (bump to `1.0.0`)

**Interfaces:**
- Consumes: the working extension
- Produces: a zip ready to upload

- [ ] **Step 1: Produce real icons**

Replace the four placeholders with actual artwork at 16, 32, 48 and 128 px. The 128 px version is what appears in the store listing.

- [ ] **Step 2: Write `docs/store/privacy-policy.md`**

State plainly: the extension collects no data, transmits nothing off-device, and has no analytics. Captured images stay in the browser and go only to the clipboard or the user's downloads folder. Google requires this document even for extensions that collect nothing.

- [ ] **Step 3: Write `docs/store/listing.md` with a justification per permission**

```markdown
- activeTab — read the current tab only when the user clicks the extension icon
- scripting — inject the measuring and scrolling script into that tab
- offscreen — stitch the captured frames and write to the clipboard, which
  Manifest V3 does not allow from a service worker
- downloads — save the resulting PNG when the user chose that output
- clipboardWrite — copy the resulting PNG when the user chose that output
- storage — remember the user's output preference
```

- [ ] **Step 4: Capture five screenshots at 1280×800**

Show: a capture in progress, the resulting full-page PNG, the options page, a before/after of a page with a fixed header, and the extension in the toolbar.

- [ ] **Step 5: Bump the version and build the upload zip**

```bash
pnpm build
cd dist && zip -r ../full-page-shot-1.0.0.zip . && cd ..
```

- [ ] **Step 6: Commit and tag**

```bash
git add -A
git commit -m "chore: add store listing assets and bump to 1.0.0"
git tag v1.0.0
git push --follow-tags
```

- [ ] **Step 7: Upload to the Chrome Web Store dashboard**

Manual step for the repo owner: create the developer account if needed (one-time US$5 fee), upload the zip, paste the listing copy and permission justifications, link the privacy policy, submit for review.

---

## Open risks

These are known unknowns, listed so they are not mistaken for oversights:

1. **`SETTLE_DELAY_MS = 120` is a guess.** Task 9's lazy-load fixture is the calibration instrument. Expect to raise it.
2. **`CAPTURE_INTERVAL_MS = 550` is a guess** at staying under the `captureVisibleTab` quota. If captures fail intermittently on long pages, this is the first constant to raise.
3. **The CRXJS output path for the content script** (`src/content/index.ts.js` in `executeScript`) must be verified against real build output in Task 7, Step 9.
4. **TypeScript 7 is very new.** If `@types/chrome` or the Vitest toolchain misbehaves, fall back to `typescript@5.9.x` per the Global Constraints.
5. **Pages using a scroll container instead of the document** (some SPAs) will capture as a single viewport. Not handled in v1; would need the content script to detect the real scrolling element.

6. **jsdom may not resolve `position: sticky`** in `getComputedStyle`. If Task 4's sticky test cannot pass against real jsdom, keep `sticky` in the production selector and assert it in the e2e layer instead — do not narrow the selector to make a unit test green.

import { describe, expect, it } from 'vitest'
// `?raw` because these are assertions about the *source text*: the point is
// what the bundler will see and eliminate, which nothing importable can show.
import backgroundSource from '../../src/background/index.ts?raw'
import offscreenSource from '../../src/offscreen/index.ts?raw'
import manifestSource from '../../src/manifest.config.ts?raw'

// The end-to-end suite drives the extension through hooks the service worker
// and the offscreen document expose, and through a manifest that carries a
// host permission the shipped extension deliberately does not ask for. All
// three are gated on `VITE_FPS_E2E`, which only `pnpm build:e2e` sets, so
// `vite build` inlines the comparison as false and drops the code.
//
// This is the cheap half of that guarantee. The other half is that
// `pnpm build` produces a `dist/` with no `__fpsCaptureForTest` and no
// `exportCapture` in it; grep for those before releasing.
describe('test hooks are excluded from the production build', () => {
  it('gates the service worker hook on the e2e build flag', () => {
    expect(backgroundSource).toContain("if (import.meta.env.VITE_FPS_E2E === '1') {")
    expect(backgroundSource).toContain('__fpsCaptureForTest')
  })

  it('leaves no test-only code in the offscreen document at all', () => {
    // Stronger than gating it. The offscreen document used to carry a
    // build-gated `exportCapture` message, because the end-to-end suite needed
    // the stitched pixels and the sinks -- which lived there and could not
    // work there -- were the only other route to them. `finishCapture` now
    // returns that image as part of the shipped protocol, so there is nothing
    // for a test-only path to do and none should grow back.
    expect(offscreenSource).not.toContain('VITE_FPS_E2E')
    expect(offscreenSource).not.toContain('exportCapture')
  })

  it('gates the e2e host permission on the same flag', () => {
    expect(manifestSource).toContain("process.env.VITE_FPS_E2E === '1'")
    // Not unconditionally present: the shipped manifest asks for no host
    // permission at all, which is the privacy claim the whole `activeTab`
    // design exists to make.
    expect(manifestSource).toContain('isE2eBuild')
  })
})

import { describe, expect, it } from 'vitest'
// `?raw` because these are assertions about the *source text* of the service
// worker's entry, not about anything it exports.
import backgroundSource from '../../src/background/index.ts?raw'

// These guard two build invariants that no other test can see, because both
// fail *silently* with a fully green suite: Task 5 shipped a content script
// that the build never emitted at all, and the first fix for that produced a
// `service-worker-loader.js` pointing at the wrong chunk. Neither is
// observable from unit tests of the modules themselves -- only from how the
// service worker's entry file is wired.
const dynamicScriptImport = /from '\.\.\/([^']*?)\?script&iife'/.exec(backgroundSource)
const injectedEntry = dynamicScriptImport?.[1] ?? ''

describe('content script build wiring', () => {
  it('pulls the content script in with ?script&iife so CRXJS emits it', () => {
    // CRXJS only bundles entries reachable from the manifest, and the content
    // script is deliberately not declared there. Without this import `dist/`
    // contains no content script and every capture dies at executeScript.
    // `iife` (not plain `?script`) because executeScript runs classic scripts.
    expect(injectedEntry).toMatch(/^content\/.+\.ts$/)
  })

  it('gives the injected entry a basename distinct from the background entry', () => {
    // Two Rollup entry chunks named `index.ts` make CRXJS 2.7.1 resolve the
    // background's chunk reference to the content script's chunk, so the
    // service worker loads the content script instead of itself.
    const injectedBasename = injectedEntry.slice(injectedEntry.lastIndexOf('/') + 1)
    expect(injectedBasename).not.toBe('index.ts')
  })
})

/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './src/manifest.config'

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    target: 'esnext',
    // CRXJS only discovers entry points it can reach by scanning the
    // manifest (background, content_scripts, action, etc.). The offscreen
    // document is loaded at runtime via `chrome.offscreen.createDocument`,
    // so nothing in the manifest references it and it would otherwise be
    // silently dropped from `dist/` — the same failure mode Task 5 hit
    // with the content script. Registering it as an explicit Rollup input
    // makes CRXJS treat it as an HTML entry and emit it (and its bundled
    // script) like any other page.
    rollupOptions: { input: { offscreen: 'src/offscreen/offscreen.html' } },
  },
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    coverage: { provider: 'v8', include: ['src/**/*.ts'], reporter: ['text', 'lcov'] },
    // environmentMatchGlobs was removed in Vitest 4; `projects` is the
    // replacement for running some test directories under jsdom while the
    // rest stay on the default `node` environment. Every jsdom-only glob
    // must be excluded from the node project too, or it runs twice — once
    // for real, once in an environment with no DOM.
    projects: [
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
          // tests/setup.ts is loaded via `setupFiles`, not a test file itself
          // — without excluding it, the broad `tests/**` include here makes
          // Vitest try to run it as a suite and fail with "No test suite
          // found".
          exclude: ['tests/content/**', 'tests/options/**', 'tests/setup.ts'],
        },
      },
    ],
  },
})

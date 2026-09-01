/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './src/manifest.config'

export default defineConfig({
  plugins: [crx({ manifest })],
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
    coverage: { provider: 'v8', include: ['src/**/*.ts'], reporter: ['text', 'lcov'] },
    // environmentMatchGlobs was removed in Vitest 4; `projects` is the
    // replacement for running some test directories under jsdom while the
    // rest stay on the default `node` environment. Add another project
    // entry here (e.g. `tests/options/**`) to extend this list.
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
  },
})

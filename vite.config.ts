/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './src/manifest.config'

export default defineConfig({
  plugins: [crx({ manifest })],
  build: { target: 'esnext' },
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

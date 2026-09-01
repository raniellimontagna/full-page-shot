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
  },
})

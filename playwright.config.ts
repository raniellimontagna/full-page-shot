import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // A capture of a six-viewport page is ~6 frames at 550ms of enforced spacing
  // each, plus a real download; 120s leaves room without hiding a hang.
  timeout: 120_000,
  expect: { timeout: 10_000 },
  // Strictly serial. Every test drives one browser whose *active tab* is part
  // of the contract under test, and the captures share one downloads folder;
  // running two at once would make both lie.
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: [['list']],
  webServer: {
    command: 'node e2e/server.mjs',
    url: 'http://localhost:5199/short.html',
    reuseExistingServer: true,
    stdout: 'ignore',
  },
})

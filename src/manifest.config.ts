import { defineManifest, type ManifestV3Export } from '@crxjs/vite-plugin'

// `defineManifest`'s declared return type is the union `ManifestV3Export`
// (object | Promise | config-fn), even when called with a plain object as
// here. Narrow it back to the resolved manifest shape so consumers (tests,
// `vite.config.ts`) can read fields like `manifest_version` directly.
type ResolvedManifest = Extract<ManifestV3Export, { manifest_version: number }>

// `activeTab` is granted by a user gesture -- a real click on the toolbar
// button -- and there is no way to synthesise that click from Playwright or
// the DevTools protocol. So the end-to-end build, and *only* that build,
// swaps in an explicit host permission for the local fixture server plus the
// `tabs` permission the harness needs to find a fixture tab by URL. It is
// written to `dist-e2e/`, never `dist/`, and `pnpm build` leaves this branch
// untaken -- see `tests/manifest.test.ts`, which asserts the shipped
// permission set unchanged.
// Declared locally rather than by adding `@types/node` to a project whose
// every other file runs in the browser or a service worker. This module is
// evaluated by Vite in Node, and this is the only Node global it touches.
declare const process: { env: Record<string, string | undefined> }
const isE2eBuild = process.env.VITE_FPS_E2E === '1'
const e2eOnly = isE2eBuild
  ? {
      // `<all_urls>`, not the fixture origin: `chrome.tabs.captureVisibleTab`
      // accepts only `<all_urls>` or `activeTab`, never a narrower host match
      // (verified -- a `http://localhost:5199/*` grant fails it with "Either
      // the '<all_urls>' or 'activeTab' permission is required"). The shipped
      // extension satisfies it with `activeTab`, which is why `dist/` needs no
      // host permission at all.
      host_permissions: ['<all_urls>'],
    }
  : {}

export default defineManifest({
  manifest_version: 3,
  name: 'Full Page Shot',
  version: '0.1.0',
  description: 'Capture the entire scrollable page in one click.',
  minimum_chrome_version: '116',
  permissions: [
    'activeTab',
    'scripting',
    'offscreen',
    'downloads',
    'clipboardWrite',
    'storage',
    ...(isE2eBuild ? (['tabs'] as const) : []),
  ],
  ...e2eOnly,
  options_page: 'src/options/options.html',
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
  // No `web_accessible_resources` here on purpose. The content script is
  // injected on demand by `chrome.scripting.executeScript` (activeTab) and is
  // never declared statically, so nothing in this file references it -- and
  // CRXJS only bundles what it can reach from the manifest, which is why the
  // build emitted no content script at all until now. Listing it as a
  // `web_accessible_resources` *resource* does NOT fix that: CRXJS treats WAR
  // entries as plain assets and copies them verbatim, so that route ships the
  // raw, unbundled `.ts` source, which cannot be injected. The working fix is
  // the `?script&iife` import in `src/background/index.ts`: CRXJS bundles that
  // into a self-contained IIFE and appends the emitted path to
  // `web_accessible_resources` in the built manifest by itself. See
  // `contentScriptPath()` there, which reads that path back at runtime.
}) as ResolvedManifest

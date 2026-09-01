import { defineManifest, type ManifestV3Export } from '@crxjs/vite-plugin'

// `defineManifest`'s declared return type is the union `ManifestV3Export`
// (object | Promise | config-fn), even when called with a plain object as
// here. Narrow it back to the resolved manifest shape so consumers (tests,
// `vite.config.ts`) can read fields like `manifest_version` directly.
type ResolvedManifest = Extract<ManifestV3Export, { manifest_version: number }>

export default defineManifest({
  manifest_version: 3,
  name: 'Full Page Shot',
  version: '0.1.0',
  description: 'Capture the entire scrollable page in one click.',
  minimum_chrome_version: '116',
  permissions: ['activeTab', 'scripting', 'offscreen', 'downloads', 'clipboardWrite', 'storage'],
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

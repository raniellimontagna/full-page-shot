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
}) as ResolvedManifest

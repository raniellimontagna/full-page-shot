// Build entry for the injected content script. It exists only to give the
// emitted bundle a basename distinct from `src/background/index.ts`.
//
// The service worker pulls the content script into the build with
// `import ... from '../content/content-script.ts?script&iife'`. Importing
// `./index.ts` there instead produces two Rollup entry chunks both named
// `index.ts`, and CRXJS then resolves the background's chunk reference to the
// wrong one: `dist/service-worker-loader.js` ends up importing the *content
// script* bundle, so the service worker runs the content script and no
// capture ever starts. Verified against @crxjs/vite-plugin 2.7.1 by building
// both ways; renaming this entry is the whole fix.
//
// `src/content/index.ts` stays the implementation (and the path the plan and
// the earlier task briefs name); this file is purely a uniquely-named handle
// on it for the bundler.
import './index'

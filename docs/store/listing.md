# Chrome Web Store listing — Full Page Shot

## Short description (≤ 132 characters)

```
Capture a full scrollable page or just the visible area — copy to clipboard or save. No accounts, no tracking, all local.
```

Character count: 121 (limit 132).

## Detailed description

```
Full Page Shot captures the entire scrollable content of the current tab —
not just what fits in the viewport — as a single PNG image, in one click.

HOW IT WORKS
Click the toolbar icon, or press Ctrl+Shift+Y (Cmd+Shift+Y on a Mac). The
extension measures the page, scrolls through it in segments, captures each
segment, and stitches them into one seamless image entirely inside your
browser. No server, no upload, no account.

TWO CAPTURE MODES
  • Full page — the whole scrollable document
  • Visible area — just what is on screen, in one instant capture
Right-click the toolbar icon to pick a mode for a single capture, press
Ctrl+Shift+U (Cmd+Shift+U) for the visible area, or set your default mode on
the options page.

Both shortcuts are suggested defaults: if another extension already claimed
one, Chrome leaves it unassigned and you can set your own at
chrome://extensions/shortcuts.

OUTPUT
Choose what happens after each capture from the options page:
  • Copy the image straight to your clipboard, ready to paste
  • Save it to your Downloads folder
  • Both
And choose what the saved file looks like:
  • 1x (default, smaller files) or 2x (every device pixel)
  • PNG, JPEG or WebP
The clipboard always receives a PNG, whatever the download format, because
that is the image type that pastes reliably everywhere.

PRIVACY
Full Page Shot collects no data, includes no analytics or tracking, and
makes no network requests. The only thing it stores is your own output
preferences (clipboard / download, capture mode, scale, format), via Chrome's
built-in settings sync —
see the linked privacy policy for the full, plain-language explanation.

LIMITATIONS
  • Full-page capture works on the page's own scroll (the normal case).
    Pages that scroll a nested container instead of the document — some
    single-page apps — will currently capture only the visible viewport.
  • Chrome-internal pages (chrome://, the Web Store, etc.) cannot be
    captured — this is a Chrome platform restriction, not a limitation of
    the extension.

No accounts. No ads. No tracking. Just a full-page screenshot.
```

## Category

**Productivity** (Chrome Web Store category). Alternative fit: **Tools**.

## Permission justifications

Per-permission justification, for the Chrome Web Store's "Permission
justification" fields. This matches the permission set actually declared in
the shipped `dist/` build (`src/manifest.config.ts`) — there is **no**
`<all_urls>` or other broad host permission in that build. (The end-to-end
test build, `dist-e2e/`, adds `<all_urls>` and `tabs` so Playwright can drive
a capture without a real user gesture; that build is never shipped or
uploaded — see the comment above `isE2eBuild` in `src/manifest.config.ts`.)

| Permission | Justification |
| --- | --- |
| `activeTab` | Grants temporary access to the current tab only when the user clicks the extension's toolbar icon — the extension never has standing access to tab content, and requests no host permissions. |
| `scripting` | Injects the script that measures the page and drives the scroll-and-capture loop into the active tab, using the temporary access `activeTab` just granted. |
| `offscreen` | Manifest V3 service workers have no DOM: they cannot decode an image or draw to a canvas. The offscreen document is where the captured frames are stitched into the final PNG. |
| `downloads` | Saves the resulting PNG to the user's Downloads folder, when the user has turned that output on in the options page. |
| `clipboardWrite` | Declared to support copying the resulting PNG to the clipboard when the user has that output turned on. **Maintainer note:** the actual clipboard write happens via `navigator.clipboard.write()` in the content script injected into the captured tab (`src/content/clipboard.ts`), which may not need this extension permission at all — it runs in a focused page context. Whether it can be dropped is still open, and **the end-to-end suite cannot answer it**: `e2e/helpers/extension.ts` grants clipboard permissions to the Playwright browser context itself, so `pnpm test:e2e` passes with or without the manifest permission. Deciding it requires a manual check in real Chrome: remove the permission, `pnpm build`, load `dist/` unpacked, set the options page to clipboard-only, capture a page, and paste into a real application. Only if that paste works should the permission be dropped from `src/manifest.config.ts`. |
| `storage` | Remembers the user's preferences (clipboard / download, default capture mode, output scale, download format) between sessions via `chrome.storage.sync`. |
| `contextMenus` | Adds a right-click menu on the extension's toolbar icon so the user can choose the capture mode — full page or visible area — for a single capture. The items are scoped to the toolbar icon (`contexts: ['action']`) and never appear on the page itself. |

## Assets checklist

- Icons: `public/icons/icon{16,32,48,128}.png` — see `public/icons/icon.svg`
  for the source artwork.
- Screenshots: `store/screenshots/*.png`, five images at 1280×800.
- Privacy policy: `docs/store/privacy-policy.md` (link this URL, once
  published, from the Chrome Web Store dashboard's privacy tab).

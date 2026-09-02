# Privacy Policy — Full Page Shot

**Last updated:** 2026-09-02

Full Page Shot is a Chrome extension that captures the entire scrollable
content of the active browser tab as a single PNG image. This document
describes, plainly and completely, what the extension does and does not do
with your data.

## Summary

Full Page Shot collects no data, transmits nothing off your device, and
contains no analytics or tracking code of any kind.

## What the extension does

When you click the toolbar icon, the extension:

1. Reads the geometry (scroll height, viewport size, device pixel ratio) of
   the currently active tab, and scrolls and screenshots it in segments.
2. Stitches those segments into a single full-page PNG image, entirely
   inside your browser (in an offscreen document — a hidden Chrome page the
   extension uses for image processing, per Chrome's Manifest V3
   requirements).
3. Delivers that PNG to the destination(s) you have chosen in the options
   page: your system clipboard, a file in your Downloads folder, or both.

## What the extension does not do

- It does not transmit the captured image, the page you captured, or any
  other data to any server. There is no backend, no API, and no network
  request the extension makes on your behalf.
- It does not include analytics, telemetry, crash reporting, or any other
  third-party tracking library.
- It does not run or fetch remote code. All code that runs is the code
  shipped in the extension package that Google reviewed.
- It does not read, log, or retain the content of pages you capture beyond
  the moment of producing the image you asked for. Nothing is stored on disk
  by the extension itself except the one PNG file it saves to Downloads when
  you choose that output.

## The one thing that does leave your device

Your two output preferences (whether captures are copied to the clipboard
and/or saved to Downloads) are stored using Chrome's `chrome.storage.sync`
API. This is a standard Chrome platform feature: it lets your preferences
follow you between Chrome installations that are signed in to the same
Google account, by syncing through your own Google account — the same way
Chrome syncs your bookmarks or browsing settings. Full Page Shot has no
access to that sync channel or its contents beyond writing these two
boolean preferences; the data never passes through any server the extension
author operates, because the extension author operates none.

No other data — captured images, page content, URLs, browsing history, or
anything else — is stored via `chrome.storage.sync` or synced anywhere.

## Permissions

See [`listing.md`](./listing.md) in this directory for a plain-language
justification of every permission the extension requests.

## Changes to this policy

If this policy changes, the "Last updated" date above will change and the
updated document will be linked from the extension's Chrome Web Store
listing.

## Contact

Questions about this policy or the extension's data practices can be sent to:
`<owner: fill in a contact email before submitting to the Chrome Web Store>`

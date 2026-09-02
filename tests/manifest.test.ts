import { describe, expect, it } from 'vitest'
import manifest from '../src/manifest.config'

describe('manifest', () => {
  it('targets Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3)
  })

  it('requests exactly the permissions the spec allows', () => {
    expect([...(manifest.permissions ?? [])].sort()).toEqual(
      ['activeTab', 'clipboardWrite', 'downloads', 'offscreen', 'scripting', 'storage'].sort(),
    )
  })

  it('never requests the debugger permission', () => {
    expect(manifest.permissions).not.toContain('debugger')
  })

  // The spec promises the shortcut in two places (§Service worker and §Fluxo
  // step 1) and the store listing tells users it exists; for a long while the
  // manifest simply had no `commands` block at all, so the promise was fiction.
  it('binds a keyboard shortcut to the toolbar action', () => {
    const command = manifest.commands?._execute_action
    expect(command).toBeDefined()
    expect(command?.suggested_key).toEqual({
      default: 'Ctrl+Shift+Y',
      mac: 'Command+Shift+Y',
    })
  })

  // `_execute_action` is Chrome's reserved command: it fires the same
  // `chrome.action.onClicked` listener a toolbar click does. A custom command
  // name would need a `chrome.commands.onCommand` listener that does not exist,
  // so the shortcut would be inert.
  it('drives the shortcut through the reserved action command', () => {
    expect(Object.keys(manifest.commands ?? {})).toEqual(['_execute_action'])
  })

  it('does not declare static content scripts', () => {
    expect(manifest).not.toHaveProperty('content_scripts')
  })
})

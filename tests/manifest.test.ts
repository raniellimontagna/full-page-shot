import { describe, expect, it } from 'vitest'
import manifest from '../src/manifest.config'

describe('manifest', () => {
  it('targets Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3)
  })

  // Exact, not a superset: `contextMenus` is the ONE permission v1.1 was
  // allowed to add (it triggers no install warning), and the whole privacy
  // claim of this extension is that the list is short and auditable.
  it('requests exactly the permissions the spec allows', () => {
    expect([...(manifest.permissions ?? [])].sort()).toEqual(
      [
        'activeTab',
        'clipboardWrite',
        'contextMenus',
        'downloads',
        'offscreen',
        'scripting',
        'storage',
      ].sort(),
    )
  })

  it('asks for no host permissions in the shipped build', () => {
    expect(manifest).not.toHaveProperty('host_permissions')
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
  it('drives the default-mode shortcut through the reserved action command', () => {
    expect(Object.keys(manifest.commands ?? {}).sort()).toEqual(
      ['_execute_action', 'capture-viewport'].sort(),
    )
  })

  // A custom name, unlike `_execute_action`, needs a `chrome.commands.onCommand`
  // listener -- which the service worker has, dispatching on exactly this id.
  it('binds a second shortcut to viewport capture', () => {
    const command = manifest.commands?.['capture-viewport']
    expect(command).toBeDefined()
    expect(command?.suggested_key).toEqual({
      default: 'Ctrl+Shift+U',
      mac: 'Command+Shift+U',
    })
  })

  it('does not declare static content scripts', () => {
    expect(manifest).not.toHaveProperty('content_scripts')
  })
})

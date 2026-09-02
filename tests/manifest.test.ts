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
      ['_execute_action', 'capture-viewport', 'capture-selection'].sort(),
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

  // The third mode gets the third shortcut. NOT Ctrl+Shift+I: that is Chrome's
  // own DevTools binding, and a browser-level binding beats an extension
  // command outright -- the command would simply never fire, with nothing
  // anywhere reporting a problem. Ctrl+Shift+S / Cmd+Shift+S is unassigned in
  // stock Chrome; if another extension claimed it first Chrome leaves it
  // unbound rather than stealing it, and the user can rebind at
  // chrome://extensions/shortcuts.
  it('binds a third shortcut to area selection', () => {
    const command = manifest.commands?.['capture-selection']
    expect(command).toBeDefined()
    expect(command?.suggested_key).toEqual({
      default: 'Ctrl+Shift+S',
      mac: 'Command+Shift+S',
    })
  })

  // Chrome hands a chord to an extension only if it has not claimed it itself,
  // and it never says so: the command is accepted, listed at
  // chrome://extensions/shortcuts, and inert. Ctrl+Shift+I is the one this
  // extension actually reached for and had to give up.
  it('claims no chord Chrome has reserved for itself', () => {
    const chords = Object.values(manifest.commands ?? {}).flatMap((command) =>
      Object.values(command.suggested_key ?? {}),
    )
    expect(chords).not.toContain('Ctrl+Shift+I')
    expect(chords).not.toContain('Command+Shift+I')
  })

  // Three modes, three commands -- and still the same seven permissions. The
  // selection overlay runs in the content script the extension already injects
  // under `activeTab`, so the third mode costs the user nothing to grant.
  it('adds no permission for the third capture mode', () => {
    expect(manifest.permissions).toHaveLength(7)
  })

  it('does not declare static content scripts', () => {
    expect(manifest).not.toHaveProperty('content_scripts')
  })
})

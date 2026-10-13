// The options page shows the shortcuts Chrome actually assigned, not the ones
// the manifest suggests: a suggestion another extension already claimed is
// left unbound, and the user can rebind any of them at
// chrome://extensions/shortcuts. `chrome.commands.getAll()` is the only source
// that reflects either, and it needs no permission.

export interface ShortcutRow {
  id: string
  label: string
  /** One entry per key cap; empty when Chrome left the command unbound. */
  keys: string[]
}

interface Command {
  name?: string
  shortcut?: string
}

// Fixed order and wording, independent of the order `getAll()` returns and of
// the manifest descriptions (Chrome reports none for `_execute_action`).
const LABELS: ReadonlyArray<readonly [id: string, label: string]> = [
  ['_execute_action', 'Capture with the default mode'],
  ['capture-viewport', 'Capture visible area'],
  ['capture-selection', 'Capture selected area'],
]

// macOS reports a shortcut as bare symbols ("⇧⌘Y"); every other platform joins
// named keys with "+" ("Ctrl+Shift+Y").
const MAC_MODIFIERS = new Set(['⌃', '⌥', '⇧', '⌘'])

export function splitShortcut(shortcut: string | undefined): string[] {
  if (!shortcut) return []
  if (shortcut.includes('+')) return shortcut.split('+')

  let split = 0
  while (split < shortcut.length && MAC_MODIFIERS.has(shortcut.charAt(split))) split++
  const modifiers = shortcut.slice(0, split).split('')
  const key = shortcut.slice(split)
  return key ? [...modifiers, key] : modifiers
}

export function toShortcutRows(commands: Command[]): ShortcutRow[] {
  const byName = new Map(commands.map((command) => [command.name, command.shortcut]))
  return LABELS.filter(([id]) => byName.has(id)).map(([id, label]) => ({
    id,
    label,
    keys: splitShortcut(byName.get(id)),
  }))
}

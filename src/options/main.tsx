import { createRoot } from 'react-dom/client'
import { App } from './App'
import { toShortcutRows } from './shortcuts'
import { loadPrefs, savePrefs } from '../shared/prefs'
import './options.css'

const loadShortcuts = async () => toShortcutRows(await chrome.commands.getAll())
// An extension page may open chrome:// URLs through the tabs API (a plain link
// to one is blocked), and `tabs.create` needs no permission.
const openShortcutSettings = () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
const version = chrome.runtime.getManifest().version

const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    <App
      load={loadPrefs}
      save={savePrefs}
      loadShortcuts={loadShortcuts}
      openShortcutSettings={openShortcutSettings}
      version={version}
    />,
  )

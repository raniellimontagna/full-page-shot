import { createRoot } from 'react-dom/client'
import { App } from './App'
import { loadPrefs, savePrefs } from '../shared/prefs'

const root = document.getElementById('root')
if (root) createRoot(root).render(<App load={loadPrefs} save={savePrefs} />)

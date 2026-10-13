import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../src/options/App'
import type { ShortcutRow } from '../../src/options/shortcuts'
import type { Prefs } from '../../src/shared/prefs'

const BASE_PREFS: Prefs = {
  toClipboard: false,
  toDownload: true,
  captureMode: 'full',
  scale: 1,
  downloadFormat: 'png',
}

describe('options App', () => {
  it('renders the stored preferences', async () => {
    const load = vi.fn(async () => BASE_PREFS)
    render(<App load={load} save={vi.fn(async () => {})} />)

    const clipboard = await screen.findByLabelText(/clipboard/i)
    const download = await screen.findByLabelText(/download/i)
    expect(clipboard).not.toBeChecked()
    expect(download).toBeChecked()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('saves when a preference is toggled', async () => {
    const save = vi.fn(async () => {})
    render(<App load={async () => BASE_PREFS} save={save} />)

    await userEvent.click(await screen.findByLabelText(/clipboard/i))
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith({ ...BASE_PREFS, toClipboard: true })
    })
  })

  it('warns when both outputs are off', async () => {
    render(
      <App
        load={async () => ({ ...BASE_PREFS, toClipboard: false, toDownload: false })}
        save={vi.fn(async () => {})}
      />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least one/i)
  })

  it('renders the stored capture mode, scale, and download format', async () => {
    render(
      <App
        load={async () => ({ ...BASE_PREFS, captureMode: 'viewport', scale: 2, downloadFormat: 'jpeg' })}
        save={vi.fn(async () => {})}
      />,
    )

    expect(await screen.findByLabelText(/visible area/i)).toBeChecked()
    expect(screen.getByLabelText(/full page/i)).not.toBeChecked()
    expect(screen.getByLabelText(/2×/i)).toBeChecked()
    expect(screen.getByLabelText(/1×/i)).not.toBeChecked()
    expect(screen.getByLabelText(/jpeg/i)).toBeChecked()
    expect(screen.getByLabelText(/^png$/i)).not.toBeChecked()
  })

  it('saves the full prefs object when capture mode changes', async () => {
    const save = vi.fn(async () => {})
    render(<App load={async () => BASE_PREFS} save={save} />)

    await userEvent.click(await screen.findByLabelText(/visible area/i))
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith({ ...BASE_PREFS, captureMode: 'viewport' })
    })
  })

  it('renders a stored "selection" capture mode', async () => {
    render(
      <App
        load={async () => ({ ...BASE_PREFS, captureMode: 'selection' })}
        save={vi.fn(async () => {})}
      />,
    )

    expect(await screen.findByLabelText(/selected area/i)).toBeChecked()
    expect(screen.getByLabelText(/full page/i)).not.toBeChecked()
    expect(screen.getByLabelText(/visible area/i)).not.toBeChecked()
  })

  it('saves the full prefs object when capture mode changes to "selection"', async () => {
    const save = vi.fn(async () => {})
    render(<App load={async () => BASE_PREFS} save={save} />)

    await userEvent.click(await screen.findByLabelText(/selected area/i))
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith({ ...BASE_PREFS, captureMode: 'selection' })
    })
  })

  it('saves the full prefs object when scale changes', async () => {
    const save = vi.fn(async () => {})
    render(<App load={async () => BASE_PREFS} save={save} />)

    await userEvent.click(await screen.findByLabelText(/2×/i))
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith({ ...BASE_PREFS, scale: 2 })
    })
  })

  it('saves the full prefs object when download format changes', async () => {
    const save = vi.fn(async () => {})
    render(<App load={async () => BASE_PREFS} save={save} />)

    await userEvent.click(await screen.findByLabelText(/webp/i))
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith({ ...BASE_PREFS, downloadFormat: 'webp' })
    })
  })

  it('notes that the clipboard always uses PNG', async () => {
    render(<App load={async () => BASE_PREFS} save={vi.fn(async () => {})} />)
    expect(await screen.findByText(/clipboard always uses PNG/i)).toBeInTheDocument()
  })

  it('names the delivery outputs without promising a PNG download', async () => {
    render(<App load={async () => BASE_PREFS} save={vi.fn(async () => {})} />)
    expect(await screen.findByRole('switch', { name: /save as a download/i })).toBeChecked()
    expect(screen.getByRole('switch', { name: /copy to clipboard/i })).not.toBeChecked()
  })

  it('shows the extension version when one is given', async () => {
    render(<App load={async () => BASE_PREFS} save={vi.fn(async () => {})} version="1.2.0" />)
    expect(await screen.findByText('v1.2.0')).toBeInTheDocument()
  })

  it('lists the keyboard shortcuts Chrome actually assigned', async () => {
    const rows: ShortcutRow[] = [
      { id: '_execute_action', label: 'Capture with the default mode', keys: ['Ctrl', 'Shift', 'Y'] },
      { id: 'capture-viewport', label: 'Capture visible area', keys: ['Ctrl', 'Shift', 'U'] },
      { id: 'capture-selection', label: 'Capture selected area', keys: [] },
    ]
    render(
      <App load={async () => BASE_PREFS} save={vi.fn(async () => {})} loadShortcuts={async () => rows} />,
    )

    const list = await screen.findByRole('list', { name: /keyboard shortcuts/i })
    const items = await within(list).findAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent(/default mode/i)
    expect(within(items[0] as HTMLElement).getAllByText(/^(Ctrl|Shift|Y)$/)).toHaveLength(3)
    expect(items[2]).toHaveTextContent(/not set/i)
  })

  it('opens Chrome\'s shortcut settings from the shortcuts section', async () => {
    const openShortcutSettings = vi.fn()
    render(
      <App
        load={async () => BASE_PREFS}
        save={vi.fn(async () => {})}
        loadShortcuts={async () => []}
        openShortcutSettings={openShortcutSettings}
      />,
    )

    await userEvent.click(await screen.findByRole('button', { name: /change shortcuts/i }))
    expect(openShortcutSettings).toHaveBeenCalledOnce()
  })

  it('leaves the shortcuts section out when shortcuts cannot be read', async () => {
    render(<App load={async () => BASE_PREFS} save={vi.fn(async () => {})} />)
    await screen.findByLabelText(/clipboard/i)
    expect(screen.queryByRole('list', { name: /keyboard shortcuts/i })).not.toBeInTheDocument()
  })
})

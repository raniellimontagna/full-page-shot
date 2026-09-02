import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../src/options/App'
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
})

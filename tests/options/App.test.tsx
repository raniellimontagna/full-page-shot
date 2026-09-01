import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../src/options/App'

describe('options App', () => {
  it('renders the stored preferences', async () => {
    const load = vi.fn(async () => ({ toClipboard: false, toDownload: true }))
    render(<App load={load} save={vi.fn(async () => {})} />)

    const clipboard = await screen.findByLabelText(/clipboard/i)
    const download = await screen.findByLabelText(/download/i)
    expect(clipboard).not.toBeChecked()
    expect(download).toBeChecked()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('saves when a preference is toggled', async () => {
    const save = vi.fn(async () => {})
    render(<App load={async () => ({ toClipboard: false, toDownload: true })} save={save} />)

    await userEvent.click(await screen.findByLabelText(/clipboard/i))
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith({ toClipboard: true, toDownload: true })
    })
  })

  it('warns when both outputs are off', async () => {
    render(<App load={async () => ({ toClipboard: false, toDownload: false })} save={vi.fn(async () => {})} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least one/i)
  })
})

// The standalone Saved seeds page's own Save seed door, and a new lot that lands after its sheet was
// closed. This door reads its list again when the sheet closes, which is BEFORE such a save lands, so
// it is told again when it does (onSavedAfterClose) and reads once more. The sheet is its own suite's
// subject (SaveSeedSheet.lateSave.test.jsx); here only what the page hands it matters.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { fetchSpy, sheetProps } = vi.hoisted(() => ({ fetchSpy: vi.fn(), sheetProps: { current: null } }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('../components/planting/SaveSeedSheet.jsx', () => ({
  default: (props) => { sheetProps.current = props; return <div data-testid="save-seed-sheet-stub" /> },
  SeedCountBasis: () => null,
}))

import SavedSeeds from '../pages/SavedSeeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const listReads = () => fetchSpy.mock.calls.filter(([p, o]) => !o?.method && String(p).startsWith('/api/inventory-items')).length

beforeEach(() => {
  sheetProps.current = null
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((path) => {
    const p = String(path)
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve([])
    if (p.startsWith('/api/inventory-items')) return Promise.resolve([])
    return Promise.resolve([])
  })
})

describe('Saved seeds (standalone) — a new lot that lands after the sheet was closed', () => {
  it('reads its list at the close, and again when the save lands; the sheet stays closed', async () => {
    await act(async () => { render(<MemoryRouter><ToastProvider><SavedSeeds /></ToastProvider></MemoryRouter>) })
    await waitFor(() => expect(screen.getByText('Saved seeds')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-open')) })
    const props = sheetProps.current
    expect(props.onSaved, 'this door leaves the ending to the sheet').toBeUndefined()
    expect(typeof props.onSavedAfterClose).toBe('function')
    const before = listReads()

    await act(async () => { props.onClose() })
    await waitFor(() => expect(listReads()).toBe(before + 1))
    expect(screen.queryByTestId('save-seed-sheet-stub')).toBeNull()

    await act(async () => { props.onSavedAfterClose({ id: 'lot-new' }, { stageWritten: null }) })
    await waitFor(() => expect(listReads()).toBe(before + 2))
    expect(screen.queryByTestId('save-seed-sheet-stub')).toBeNull()
  })
})

// BUG-SEEDYEARNOOP-001 — what InventoryDetail puts on the wire for a seed lot's harvest year.
//
// The Lambda half is proved in lambda/inventory-items/put-year-harvested.test.js: the SET list now
// assigns year_harvested, and assigns it through an explicit-presence CASE rather than a bare
// assignment. This file answers the client half, and it answers it by MEASUREMENT rather than by
// reading buildChanges(): useInventory.updateItem() does not send buildChanges() output directly, it
// merges `{...currentListRow, ...changes}` whenever the row is in its own list. That merge is
// exactly what made the original defect invisible in ordinary use, so a test that mocked it away
// would assert its own stub.
//
// THE DECISIVE CASE IS THE DEGRADED ONE. The four curated rows — Hopi Black Dye Sunflower 2025,
// Jen's Edelweiss 1986, Red Mustard 2026, Common Milkweed 2022 — survived to today only because the
// SET list omitted the column. Now that it is assigned, the danger inverts: a body that omits the
// key on the deep-link path (list never loaded) is the one that could null them. The server's
// presence guard is the real protection; this file proves the client no longer produces such a body
// for a seed row at all, so the two guards are independent rather than one guard counted twice.
//
// Same harness and same reasoning as InventoryDetail.seedPut.test.jsx in this directory.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy, navigateSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn(), navigateSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useParams: () => ({ id: 'inv-seed-1' }),
  useNavigate: () => navigateSpy,
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <span data-testid="photo-upload" /> }))
vi.mock('../components/forms/PlantingSelect.jsx', () => ({ default: () => <span data-testid="planting-select" /> }))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

// Modelled on Jen's Edelweiss — a real prod row, and the one with most to lose. 1986 rather than a
// recent year on purpose: a fixture picked from the happy path would not notice a bug that only
// bites values the current-year default could plausibly overwrite.
const SEED = {
  id: 'inv-seed-1', name: 'Edelweiss', type: 'consumable', category: 'seeds',
  status: 'active', quantity_on_hand: 1, unit: 'packet', notes: 'Brought from Austria',
  source: 'Jen', variety_id: 'var-edelweiss', variety_name: 'Edelweiss',
  seed_stage: null, seed_process: null, source_plant_id: null,
  year_harvested: 1986,
}
// A durable tool. The harvest-year key must not appear in ITS payload at all — an omitted key is
// what tells the server to leave the column alone.
const TOOL = {
  ...SEED, name: 'Hori Hori Knife', type: 'durable', category: 'tools',
  quantity: 1, condition: 'good', quantity_on_hand: null, unit: null,
  variety_id: null, variety_name: null, year_harvested: null,
}

function wire({ row = SEED, listRows }) {
  fetchSpy.mockImplementation((path, opts) => {
    if (path === '/api/inventory-items/inv-seed-1' && !opts) return Promise.resolve(row)
    if (path === '/api/inventory-items') {
      return listRows ? Promise.resolve(listRows) : Promise.reject(new Error('offline'))
    }
    if (path === '/api/inventory-items/inv-seed-1' && opts?.method === 'PUT') {
      return Promise.resolve({ ...row, ...JSON.parse(opts.body) })
    }
    return Promise.resolve(null)
  })
}

const putCall = () => fetchSpy.mock.calls.find(([, o]) => o?.method === 'PUT')
const putBody = () => {
  const call = putCall()
  expect(call, 'no PUT was issued').toBeTruthy()
  return JSON.parse(call[1].body)
}

async function renderPage() {
  await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await waitFor(() => expect(screen.getByLabelText('Name')).toBeTruthy())
}
async function save() {
  await act(async () => { fireEvent.click(screen.getByText('Save changes')) })
}

beforeEach(() => { fetchSpy.mockReset(); navigateSpy.mockReset() })

describe('BUG-SEEDYEARNOOP-001 — the harvest-year field on InventoryDetail', () => {
  it('renders the stored year for a seed lot — the first surface in the app that does', async () => {
    wire({ listRows: [SEED] })
    await renderPage()
    expect(screen.getByTestId('inv-year-harvested').value).toBe('1986')
  })

  it('sends the year even when the inventory list never loaded — the deep-link path', async () => {
    // THE ONE THAT MATTERS. On this path updateItem has no list row to merge, so buildChanges()
    // reaches the wire raw. Before this fix the key was absent here, which is precisely the body
    // that would null a curated value once the server started assigning the column.
    wire({ listRows: null })
    await renderPage()
    await save()
    expect(putBody().year_harvested).toBe(1986)
  })

  it('sends an edited year as a number, not a string', async () => {
    // The column is `integer`. A quoted "2025" would reach Postgres as text and rely on an implicit
    // cast that the driver does not always supply.
    wire({ listRows: [SEED] })
    await renderPage()
    fireEvent.change(screen.getByTestId('inv-year-harvested'), { target: { value: '2025' } })
    await save()
    expect(putBody().year_harvested).toBe(2025)
  })

  it('sends null when the field is emptied — clearing must stay possible', async () => {
    // Presence, not truthiness, is the whole reason the server uses hasOwnProperty: a year entered
    // by mistake has to be removable. Blank is a real clear, and is distinct from the omission case
    // below.
    wire({ listRows: [SEED] })
    await renderPage()
    fireEvent.change(screen.getByTestId('inv-year-harvested'), { target: { value: '' } })
    await save()
    expect(putBody().year_harvested).toBe(null)
  })

  it('refuses to save an unparseable year instead of silently clearing it', async () => {
    // parseNum maps both '' and NaN to null, so without the validator a typo would read as "the
    // user emptied the field" and null a curated value with a 200 and no message.
    wire({ listRows: [SEED] })
    await renderPage()
    fireEvent.change(screen.getByTestId('inv-year-harvested'), { target: { value: '19 86' } })
    await save()
    expect(putCall(), 'a PUT was issued despite an invalid year').toBeFalsy()
    expect(screen.getByText(/four-digit year/)).toBeTruthy()
  })

  it('omits the key entirely for a non-seed item, and shows no field', async () => {
    // A hammer has no opinion about a harvest year. Omission is not tidiness — it is what makes the
    // server's ELSE branch preserve the column rather than write null over it.
    wire({ row: TOOL, listRows: null })
    await renderPage()
    expect(screen.queryByTestId('inv-year-harvested')).toBe(null)
    await save()
    expect(putBody()).not.toHaveProperty('year_harvested')
  })
})

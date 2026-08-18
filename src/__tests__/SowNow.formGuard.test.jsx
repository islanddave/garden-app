// V4-RELOADGATEWIRE-001 — proves SowNow's form-guard wiring: the Sow sheet's draft stash,
// the overlay-dirty report, and the service-worker reload gate.
//
// SowNow's own local state carries no typed text — the only thing here a reload/dismiss could
// destroy is WHICH packet the Sow sheet is open on (`sowTarget`), set from either an ordinary Sow
// tap or the "Sow anyway" engine-override tap on a gated hold. PlantingEditor owns its own field
// state (place/quantity/notes) with no callback SowNow can observe, so the stash recovers the
// packet, not the sheet's contents — see the reasoning comment on `dirty` in SowNow.jsx itself.
//
// Real reloadGate, real draftStash (sessionStorage), real OverlayContext — nothing mocked between
// them, mirroring EventNew.reloadGateWire.test.jsx: a test that spied on setReloadBlocked/writeDraft
// instead would prove only that SowNow CALLS them, not that the whole channel actually holds/persists.
//
// Harness mirrors SowNow.test.jsx (real sowEngine, fixed today=2026-07-10, same fetch routing shape).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchSpy, navigateSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
}))

// Same pin as SowNow.test.jsx — this suite predates the PROJECTS_HIDDEN flip and exercises the
// projects-visible UI (a live configuration; rollback is a one-line revert).
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
  apiFetch: (...a) => fetchSpy(...a),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
}))

import SowNow from '../pages/SowNow.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { OverlayDirtyProvider } from '../context/OverlayContext.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

const TODAY = '2026-07-10'
const STASH_KEY = 'gardenApp.draft.sow-now'

// Verified against the real engine for today=2026-07-10 (see SowNow.test.jsx): lands in
// window_closing with an actionable "Sow" button.
const CUCUMBER = {
  inventory_item_id: 'inv-cuke', item_name: 'Spacemaster 80 Cucumber Seeds',
  variety_name: 'Spacemaster 80', variety_id: 'var-cuke',
  quantity_on_hand: '1', unit: 'packet', created_by: 'user_x',
  purchase_date: '2026-06-09', source: 'Botanical Interests', metadata: {},
  crop_type_slug: 'cucumber', lifecycle: 'annual', grown_as: null,
  sun_requirements: 'full_sun', days_to_maturity_min: '55', days_to_maturity_max: '62',
  start_method: 'direct_sow', start_indoor_weeks_min: null, start_indoor_weeks_max: null,
  direct_sow_timing: 'direct sow after last frost',
  sow_depth_in: '0.5', seed_spacing_in: '12', row_spacing_in: null,
  days_to_germ_min: '3', days_to_germ_max: '10', sow_season: 'warm', sow_notes: null,
}
// Verified against the real engine (see SowNow.test.jsx "allium gate" describe): a GATED hold —
// carries the "Sow ... anyway" override button, the second (and only other) entry point into
// `sowTarget`.
const FLAT_OF_ITALY = {
  inventory_item_id: 'inv-flatitaly', item_name: 'Flat of Italy Onion Seeds',
  variety_name: 'Flat of Italy', variety_id: 'var-flatitaly',
  quantity_on_hand: '1', unit: 'packet', created_by: 'user_x',
  purchase_date: '2026-06-09', source: 'Botanical Interests', metadata: {},
  crop_type_slug: 'onion', lifecycle: 'annual', grown_as: 'annual',
  sun_requirements: 'full_sun', days_to_maturity_min: '70', days_to_maturity_max: '70',
  start_method: 'both', start_indoor_weeks_min: '10', start_indoor_weeks_max: '12',
  direct_sow_timing: '4-6 weeks before last frost or as soon as soil can be worked',
  sow_depth_in: '0.25', seed_spacing_in: '4', row_spacing_in: '12',
  days_to_germ_min: '7', days_to_germ_max: '14', sow_season: 'cool', sow_notes: null,
  growth_habit: 'Intermediate-day (leaning intermediate-to-long-day) heirloom Italian cipollini; forms flattened, disk-shaped bulbs rather than tall globes. Biennial grown as a warm-season annual for bulb harvest.',
  day_length_response: null,
}
const PROJECT = { id: 'proj-peppers', name: 'Peppers' }

function readStash() {
  const raw = sessionStorage.getItem(STASH_KEY)
  return raw ? JSON.parse(raw).data : null
}
function seedStash(data) {
  sessionStorage.setItem(STASH_KEY, JSON.stringify({ v: 1, data }))
}

function routeFetch({ candidates = [CUCUMBER], projects = [PROJECT], plantResponse = { id: 'plant-1' } } = {}) {
  fetchSpy.mockImplementation((url, opts = {}) => {
    if (url === '/api/inventory-items/sow-candidates') return Promise.resolve({ items: candidates })
    if (url === '/api/projects') return Promise.resolve(projects)
    if (url === '/api/locations/with-path') return Promise.resolve([])
    if (url.startsWith('/api/inventory-items/')) {
      const id = url.split('/').pop()
      const c = candidates.find((x) => x.inventory_item_id === id)
      return Promise.resolve({ id, name: c?.item_name ?? 'Packet', source: c?.source ?? null, purchase_date: c?.purchase_date ?? null, brand: null, metadata: {} })
    }
    if (url.startsWith('/api/varieties/')) {
      const id = url.split('/').pop()
      const c = candidates.find((x) => x.variety_id === id)
      return Promise.resolve({ id, name: c?.variety_name ?? 'Variety' })
    }
    if (url === '/api/plants' && opts.method === 'POST') return Promise.resolve(plantResponse)
    return Promise.resolve({})
  })
}

function tree({ dirtySpy } = {}) {
  const page = <SowNow todayISO={TODAY} />
  return (
    <ToastProvider>
      {dirtySpy ? <OverlayDirtyProvider onDirtyChange={dirtySpy}>{page}</OverlayDirtyProvider> : page}
    </ToastProvider>
  )
}

async function renderSowNow(opts) {
  let utils
  await act(async () => { utils = render(tree(opts)) })
  return utils
}

beforeEach(() => {
  fetchSpy.mockReset()
  navigateSpy.mockReset()
  sessionStorage.clear()
  clearReloadBlocks()
})

describe('SowNow draft stash (V4-RELOADGATEWIRE-001)', () => {
  it('a pristine mount persists nothing', async () => {
    routeFetch()
    await renderSowNow()
    await screen.findByText('Spacemaster 80')
    expect(readStash()).toBeNull()
  })

  it('opening the Sow sheet persists which packet is mid-sow', async () => {
    routeFetch()
    await renderSowNow()
    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Sow Spacemaster 80'))
    })
    expect(readStash()).toEqual({ inventoryItemId: 'inv-cuke' })
  })

  // The other entry point into sowTarget — proves the predicate/stash cover the OVERRIDE tap too,
  // not just the ordinary Sow button.
  it('the "Sow anyway" override tap on a gated hold also persists', async () => {
    routeFetch({ candidates: [FLAT_OF_ITALY] })
    await renderSowNow()
    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Sow Flat of Italy anyway'))
    })
    expect(readStash()).toEqual({ inventoryItemId: 'inv-flatitaly' })
  })

  it('restores the sheet on remount, validated against live data', async () => {
    seedStash({ inventoryItemId: 'inv-cuke' })
    routeFetch()
    await renderSowNow()
    const dialog = await screen.findByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('Sow Spacemaster 80')
    // The embedded PlantingEditor genuinely mounted on the restored target, not just a bare shell.
    expect(within(dialog).getByLabelText(/Project/i)).toBeDefined()
  })

  it('ignores a stashed id that no longer resolves against fresh candidates', async () => {
    seedStash({ inventoryItemId: 'inv-vanished' })
    routeFetch()
    await renderSowNow()
    await screen.findByText('Spacemaster 80')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('clears the draft on a successful sow', async () => {
    routeFetch()
    await renderSowNow()
    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Sow Spacemaster 80'))
    })
    expect(readStash()).toEqual({ inventoryItemId: 'inv-cuke' })

    const sheet = screen.getByRole('dialog')
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: /Add planting/i }))
    })
    await screen.findByText(/Sown/)
    expect(readStash()).toBeNull()
  })

  // NOT cleared on an explicit Close — same rule EventNew/LogMany apply: the stash exists precisely
  // to survive a dismiss, so it must still be there to resume from on the next visit.
  it('does NOT clear the draft on an explicit Close — it survives for recovery', async () => {
    routeFetch()
    await renderSowNow()
    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Sow Spacemaster 80'))
    })
    const sheet = screen.getByRole('dialog')
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(readStash()).toEqual({ inventoryItemId: 'inv-cuke' })
  })
})

describe('SowNow ↔ overlay-dirty + reload gate (V4-RELOADGATEWIRE-001)', () => {
  it('a pristine mount holds neither channel', async () => {
    const dirtySpy = vi.fn()
    routeFetch()
    await renderSowNow({ dirtySpy })
    await screen.findByText('Spacemaster 80')
    expect(isReloadBlocked()).toBe(false)
    expect(dirtySpy).not.toHaveBeenCalledWith(true)
  })

  it('opening the Sow sheet holds the reload gate AND reports dirty to the hosting overlay — same predicate, same moment', async () => {
    const dirtySpy = vi.fn()
    routeFetch()
    await renderSowNow({ dirtySpy })
    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Sow Spacemaster 80'))
    })
    expect(isReloadBlocked()).toBe(true)
    expect(dirtySpy).toHaveBeenLastCalledWith(true)
  })

  it('closing the sheet releases both', async () => {
    const dirtySpy = vi.fn()
    routeFetch()
    await renderSowNow({ dirtySpy })
    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Sow Spacemaster 80'))
    })
    const sheet = screen.getByRole('dialog')
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
    })
    expect(isReloadBlocked()).toBe(false)
    expect(dirtySpy).toHaveBeenLastCalledWith(false)
  })

  it('a successful sow releases the reload gate', async () => {
    routeFetch()
    await renderSowNow()
    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Sow Spacemaster 80'))
    })
    expect(isReloadBlocked()).toBe(true)
    const sheet = screen.getByRole('dialog')
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: /Add planting/i }))
    })
    await screen.findByText(/Sown/)
    expect(isReloadBlocked()).toBe(false)
  })

  // BUG-STALECLIENT-001: a hold that outlives its form wedges every future update.
  it('unmounting a dirty page releases the gate', async () => {
    routeFetch()
    const { unmount } = await renderSowNow()
    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Sow Spacemaster 80'))
    })
    expect(isReloadBlocked()).toBe(true)
    unmount()
    expect(isReloadBlocked()).toBe(false)
  })
})

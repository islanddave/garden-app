// V4-RELOADGATEWIRE-001 — proves SowNow's form-guard wiring: the Sow sheet's draft stash,
// the overlay-dirty report, and the service-worker reload gate.
//
// SowNow's own local state carries no typed text — the only thing here a reload/dismiss could
// destroy is WHICH packet the Sow sheet is open on (`sowTarget`), set from either an ordinary Sow
// tap or the "Sow anyway" engine-override tap on a gated hold. PlantingEditor owns its own field
// state (place/quantity/notes) and reports only a BOOLEAN out of it (`onDirty`), so the stash
// recovers the packet, not the sheet's contents — see the reasoning comment on `dirty` in SowNow.jsx
// itself, and the V4-PLANTEDITORWIRE-001 describe at the bottom of this file for what that boolean
// IS wired to: the Sheet's backdrop guard.
//
// THE STASH IS ABNORMAL-EXIT-ONLY HERE, and that is the one place this page's contract diverges
// from EventNew/LogMany. Restoring `sowTarget` re-OPENS a modal; restoring their drafts refills
// fields in a form the user is already looking at. So an explicit Close clears the stash (a
// dismissal is a decision) and only an exit the guard could not defer — SW reload, hard refresh,
// navigating away mid-sheet — leaves it behind to resume from.
//
// Real reloadGate, real registerSW, real draftStash (sessionStorage), real OverlayContext — nothing
// mocked between them, mirroring EventNew.reloadGateWire.test.jsx: a test that spied on
// setReloadBlocked/writeDraft instead would prove only that SowNow CALLS them, not that the whole
// channel actually holds/persists.
//
// Harness mirrors SowNow.test.jsx (real sowEngine, fixed today=2026-07-10, same fetch routing shape).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react'
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
import { registerServiceWorker } from '../lib/registerSW.js'

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

const flush = () => new Promise((r) => setTimeout(r, 0))

// Ported verbatim from EventNew.reloadGateWire.test.jsx (itself mirroring registerSW.test.js
// makeEnv): a PRIOR controller, so controllerchange counts as an UPDATE — the reload path — rather
// than a first install claiming the page.
function makeSwEnv() {
  const registration = { update: vi.fn().mockResolvedValue(undefined) }
  const sw = new EventTarget()
  sw.controller = {}
  sw.register = vi.fn().mockResolvedValue(registration)
  const nav = { serviceWorker: sw }
  const win = Object.assign(new EventTarget(), { location: { reload: vi.fn() } })
  const doc = Object.assign(new EventTarget(), { readyState: 'complete', visibilityState: 'visible' })
  const reload = vi.fn()
  return { registration, sw, nav, win, doc, reload }
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
  // not just the ordinary Sow button. Asserts BOTH channels the tap has to arm: a stash with no
  // reload hold recovers the packet but still lets a mid-sheet deploy blow the form away.
  it('the "Sow anyway" override tap on a gated hold persists AND holds the reload gate', async () => {
    routeFetch({ candidates: [FLAT_OF_ITALY] })
    await renderSowNow()
    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Sow Flat of Italy anyway'))
    })
    expect(readStash()).toEqual({ inventoryItemId: 'inv-flatitaly' })
    expect(isReloadBlocked()).toBe(true)
  })

  // Restore is for an ABNORMAL exit — one the guards could not defer (SW reload, hard refresh,
  // navigating away with the sheet still open). Deliberately never touches Close: a dismissed sheet
  // clears its stash (below), so a restore test that closed first would be asserting the opposite
  // contract.
  it('restores the sheet after an abnormal exit — unmounted with the sheet still open', async () => {
    routeFetch()
    const { unmount } = await renderSowNow()
    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Sow Spacemaster 80'))
    })
    unmount()
    expect(readStash()).toEqual({ inventoryItemId: 'inv-cuke' })

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

  // CLEARED on an explicit Close — the one place this page's rule inverts EventNew/LogMany's.
  // Restoring `sowTarget` re-opens a modal rather than refilling a visible form, so a surviving
  // stash would re-open a sheet the user deliberately dismissed, every later visit to /sow in the
  // tab, with no way to make it stop short of sowing the packet.
  it('an explicit Close clears the draft', async () => {
    routeFetch()
    await renderSowNow()
    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Sow Spacemaster 80'))
    })
    expect(readStash()).toEqual({ inventoryItemId: 'inv-cuke' })

    const sheet = screen.getByRole('dialog')
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(readStash()).toBeNull()
  })

  // The editor's own Cancel is the second explicit-close path (Sheet Close is chrome, Cancel is
  // inside the form) — both land on the same handler, and a fix wired to only one of them leaves
  // the resurrection bug reachable from the other.
  it("the editor's own Cancel clears the draft too", async () => {
    routeFetch()
    await renderSowNow()
    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Sow Spacemaster 80'))
    })
    const sheet = screen.getByRole('dialog')
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(readStash()).toBeNull()
  })

  // The user-visible harm the clear exists to prevent, asserted end to end rather than by proxy.
  it('a closed sheet does not re-open itself on the next visit to /sow', async () => {
    routeFetch()
    const { unmount } = await renderSowNow()
    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Sow Spacemaster 80'))
    })
    const sheet = screen.getByRole('dialog')
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
    })
    unmount()

    await renderSowNow()
    // Waited on by ROLE, not by text or bare label: a resurrected sheet repeats the packet name in
    // both its title and its own aria-label, so the looser queries die on an ambiguous match
    // instead of on the assertion that matters.
    await screen.findByRole('button', { name: 'Sow Spacemaster 80' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

// MIXED-STATUS SUITE — read the two channels differently.
//
//   isReloadBlocked() assertions  → SHIPPED behavior. /sow is a full-page route, and the reload gate
//                                   is the guard that actually runs there.
//   dirtySpy assertions           → FORWARD-COMPAT CONTRACT ONLY, true of this harness and vacuous
//                                   about production. App.jsx registers `/sow` as a plain route with
//                                   NO `overlayable` flag (unlike /log, /log/many, /put-up), so no
//                                   OverlayDirtyProvider is ever mounted above SowNow in prod and
//                                   useReportOverlayDirty is inert there. The provider below is
//                                   manufactured by `tree({ dirtySpy })`. These assertions pin what
//                                   the page must do the day /sow becomes overlayable — they are not
//                                   evidence that anything is guarded today.
describe('SowNow ↔ overlay-dirty (forward-compat) + reload gate (V4-RELOADGATEWIRE-001)', () => {
  it('a pristine mount holds neither channel', async () => {
    const dirtySpy = vi.fn()
    routeFetch()
    await renderSowNow({ dirtySpy })
    await screen.findByText('Spacemaster 80')
    expect(isReloadBlocked()).toBe(false)
    expect(dirtySpy).not.toHaveBeenCalledWith(true)
  })

  it('opening the Sow sheet holds the reload gate AND (for a future overlayable /sow) reports dirty — same predicate, same moment', async () => {
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

// Ported from EventNew.reloadGateWire.test.jsx. Everything above asserts on isReloadBlocked(), which
// proves SowNow drives the primitive correctly — but the primitive shipped fully built, unit-tested
// and green while NOTHING called it, so "the flag is set" is exactly the assertion that missed a
// wholly inert channel once already. These two run the real registerServiceWorker against the real
// gate and assert on an actual reload() that did or did not happen.
describe('SowNow ↔ registerSW, end to end (V4-RELOADGATEWIRE-001)', () => {
  it('END TO END: an open Sow sheet DEFERS the SW reload, and unmount lets it fire exactly once', async () => {
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()

    routeFetch()
    const { unmount } = await renderSowNow()
    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Sow Spacemaster 80'))
    })

    // A deploy lands with the sheet open. Reloading here takes the place/quantity/notes typed into
    // the embedded PlantingEditor with it — the fields the stash provably cannot restore.
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).not.toHaveBeenCalled()

    // Deferred, NOT cancelled (BUG-STALECLIENT-001): the moment the sheet is gone it lands.
    unmount()
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('with no sheet open, a controllerchange still reloads immediately (gate is not a disarm)', async () => {
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()

    routeFetch()
    await renderSowNow()
    await screen.findByText('Spacemaster 80')
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })
})

// ── V4-PLANTEDITORWIRE-001 — the embedded editor's dirty signal reaches the Sheet ────────────────
//
// The reload gate above holds on `!!sowTarget`, so it already covers everything the editor could be
// holding — editorDirty ⟹ sowTarget, and an OR of the two is arithmetically the same predicate.
// What `!!sowTarget` never covered is the BACKDROP: Sheet no-ops a backdrop tap only while `dirty`,
// and this page passed no `dirty` at all, so until now a stray tap beside a half-filled sow form
// discarded every field in it with no confirmation and nothing stashed to recover them from.
//
// So these tests run in BOTH directions on purpose. An always-dirty sheet is not the safe failure
// here — it makes the dominant mobile dismissal gesture silently inert for every sow, including the
// far more common one where the sheet was opened by mistake and holds nothing. The pair
// "untouched → backdrop closes" / "typed → backdrop no-ops" is the whole contract, and either one
// alone passes for a constant.
describe('SowNow — Sheet backdrop guard over the embedded editor (V4-PLANTEDITORWIRE-001)', () => {
  // The backdrop is the fixed div rendered immediately before the panel (Sheet.jsx), matched by
  // position rather than by a style-substring query: this page renders other fixed elements and
  // `container.querySelector('div[style*="position: fixed"]')` would be a lottery among them.
  const backdrop = () => screen.getByRole('dialog').previousElementSibling

  async function openSheet() {
    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Sow Spacemaster 80'))
    })
    const dialog = await screen.findByRole('dialog')
    // The packet/variety prefill has landed — so "untouched" below really means untouched-with-
    // fields-already-filled, which is the state a truthiness predicate would misread as dirty.
    await waitFor(() => expect(within(dialog).getByLabelText(/Name/i).value).toBe('Spacemaster 80 Cucumber Seeds'))
    return dialog
  }

  async function typeInEditor(dialog) {
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText('Quantity'), { target: { value: '6' } })
    })
    expect(within(dialog).getByLabelText('Quantity').value).toBe('6')
  }

  // ★ The over-broad killer. Machine-prefilled name + variety, user typed nothing: the backdrop
  // must still dismiss, or every mis-tapped Sow becomes a sheet you cannot tap your way out of.
  it('a backdrop tap CLOSES an untouched sow sheet, prefilled fields and all', async () => {
    routeFetch()
    await renderSowNow()
    await openSheet()
    await act(async () => { fireEvent.click(backdrop()) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // ★ The guard. Same sheet, one field changed inside the child component.
  it('a backdrop tap does NOT close once something has been typed into the editor', async () => {
    routeFetch()
    await renderSowNow()
    const dialog = await openSheet()
    await typeInEditor(dialog)
    await act(async () => { fireEvent.click(backdrop()) })
    expect(screen.getByRole('dialog')).toBeDefined()
    expect(within(screen.getByRole('dialog')).getByLabelText('Quantity').value).toBe('6')
  })

  // ⚠️ THESE TWO PIN THE UNREGISTERED FALLBACK, NOT PRODUCTION (BUG-DIRTYDISMISSGAP-001).
  //
  // This file mounts NO DismissRegistryProvider, so `registered` is false: Sheet's labelled Close
  // falls back to calling onClose directly and Escape runs Sheet's own legacy keydown
  // (Sheet.jsx:123-125), neither of which consults the registry. That fallback must stay
  // byte-identical for isolated tests and for a flag-off build, and these two assert it.
  //
  // In production — provider mounted, `confirmOnDirty` passed on this Sheet — both gestures now
  // raise ConfirmSheet instead. That is asserted in SowNow.backNavDirty.test.jsx, which mounts a
  // real provider and real window.history. Do not read the two titles below as the shipped contract;
  // they used to be, and pinning the defect as the spec is exactly what this comment now prevents.
  it('with NO provider, the labelled Close still closes a dirty sheet (unregistered fallback)', async () => {
    routeFetch()
    await renderSowNow()
    const dialog = await openSheet()
    await typeInEditor(dialog)
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('with NO provider, Escape still closes a dirty sheet (Sheet\'s legacy keydown)', async () => {
    routeFetch()
    await renderSowNow()
    const dialog = await openSheet()
    await typeInEditor(dialog)
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // The signal must RESET with the editor it came from. A page-level flag that survived the close
  // would leave the next sow sheet born backdrop-proof, which is the stuck-guard shape that made
  // OverlayDirtyWiring's "content unmount resets the host" assertion necessary.
  it('a sheet re-opened after a dirty close is backdrop-dismissable again', async () => {
    routeFetch()
    await renderSowNow()
    const dialog = await openSheet()
    await typeInEditor(dialog)
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    })
    expect(screen.queryByRole('dialog')).toBeNull()

    await openSheet()
    await act(async () => { fireEvent.click(backdrop()) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // A dirty backdrop must not become a blocked SAVE. The create path closes the sheet itself
  // (onCreated → closeSowSheet), which never routes through the backdrop guard.
  it('a dirty sheet still sows — the guard defends the fields, it does not trap them', async () => {
    routeFetch()
    await renderSowNow()
    const dialog = await openSheet()
    await typeInEditor(dialog)
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Add planting/i }))
    })
    await screen.findByText(/Sown/)
    expect(screen.queryByRole('dialog')).toBeNull()
    const post = fetchSpy.mock.calls.find((c) => c[0] === '/api/plants' && c[1]?.method === 'POST')
    expect(JSON.parse(post[1].body).quantity).toBe(6)
  })

  // Pins the decision NOT to narrow the reload gate to the editor's signal. The stash restores a
  // sheet on a packet the user chose, and that choice is worth deferring a deploy for whether or not
  // a field has been filled — so an untouched sheet must STILL hold the gate.
  it('an untouched sheet still holds the reload gate — the editor signal narrows nothing', async () => {
    routeFetch()
    await renderSowNow()
    await openSheet()
    expect(isReloadBlocked()).toBe(true)
    await act(async () => { fireEvent.click(backdrop()) })
    expect(isReloadBlocked()).toBe(false)
  })
})

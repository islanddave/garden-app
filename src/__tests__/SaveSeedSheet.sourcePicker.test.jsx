/**
 * V5-SEEDSOURCEPICKER-001 — the named source on the Save-seed sheet.
 *
 * Dave, 2026-09-07: "seed saving has no way to tell which source is there - I can note it is a Farm
 * Stand, but not which." The no-planting arm offered `source_kind` — the eight-value CHECK — and
 * nothing else, so every farm stand, swap and shop in the seed library came back as the same three
 * rows of vocabulary. `source_id` / `acquired_from_source_id` shipped with V5-SOURCEPICKER-001 and
 * were already wired into four surfaces; this sheet was the one intake door that missed them.
 *
 * THE PICKER IS THE REAL ONE, not a stub, and that is the point of this file rather than an
 * accident of setup. The unit under test is a WIRING: what makes it work is that the id the picker
 * emits survives all the way into the POST body, and a stub that fires `onChange('src-x')` proves
 * the second half while assuming the first. So the fixture serves /api/varieties/sources, the tests
 * click a real option row, and the assertions read the KEY out of the request body — the shape
 * BUG-SEEDPOSTDROPSPARENT-001 taught this flow to test, where a 201 came back with the provenance
 * silently dropped and every "the request was made" assertion stayed green.
 *
 * EVERY NEEDLE IS UNIQUE and rows resolve through `<picker-testid>-opt-<id>`, scoped to ONE
 * picker's root — both listboxes can be open at once, so a global query would silently take
 * whichever came first. No jest-dom (L-182): plain DOM reads.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchMock, navigateSpy } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  navigateSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...a) => fetchMock(...a),
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
// VarietyPicker drags useCachedFetch + dataCache + Clerk behind it and hangs a bare render; it is
// not the unit under test. The stub satisfies chk_inventory_seed_requires_variety through the UI,
// exactly as SaveSeedSheet.agnostic.test.jsx does.
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: ({ onChange }) => (
    <button type="button" data-testid="stub-pick-variety" onClick={() => onChange({ id: 'var-7', name: 'Carolina Reaper' })}>
      pick variety
    </button>
  ),
}))
// ONLY PlantingSelect is stubbed out of the barrel — it self-fetches. Field and SourcePicker come
// through `importActual` deliberately: they are what this file exists to exercise.
vi.mock('../components/forms', async (importActual) => ({
  ...(await importActual()),
  PlantingSelect: ({ onChange }) => (
    <button type="button" data-testid="stub-pick-planting" onClick={() => onChange('pl-3', { id: 'pl-3', name: 'Brandywine' })}>
      pick planting
    </button>
  ),
}))

import SaveSeedSheet from '../components/planting/SaveSeedSheet.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

// Server order: WHERE deleted_at IS NULL ORDER BY name ASC. Three real shapes of the thing Dave
// cannot currently name — a farm stand, the co-op he might buy a packet AT, and a seed company that
// bred one he bought there.
const SOURCES = [
  { id: 'src-bardwell', name: "Bardwell's Farm Stand", kind: 'farm_stand', locality: 'Hatfield, MA', address: null, website_url: null, notes: null },
  { id: 'src-fedco', name: 'Fedco Seeds', kind: 'seed_company', locality: 'Clinton, ME', address: null, website_url: null, notes: null },
  { id: 'src-coop', name: 'Greenfield Farmers Co-op', kind: 'garden_center', locality: 'Greenfield, MA', address: null, website_url: null, notes: null },
]

const PL = {
  id: 'pl1', name: 'Brandywine #2',
  variety_id: 'v-brandywine',
  variety_ref: { id: 'v-brandywine', name: 'Brandywine' },
}

beforeEach(() => {
  navigateSpy.mockReset()
  fetchMock.mockReset()
  fetchMock.mockImplementation((path) => {
    if (path === '/api/varieties/sources') return Promise.resolve(SOURCES)
    if (path === '/api/varieties/source-kinds') return Promise.resolve([])
    if (path === '/api/inventory-items') return Promise.resolve({ id: 'inv-42' })
    return Promise.resolve({})
  })
})

const createCall = () => fetchMock.mock.calls.find(([u, i]) => u === '/api/inventory-items' && i?.method === 'POST')
const createBody = () => { const c = createCall(); return c ? JSON.parse(c[1].body) : null }
const has = (k) => Object.prototype.hasOwnProperty.call(createBody() ?? {}, k)

async function open(planting) {
  await act(async () => {
    render(<ToastProvider><SaveSeedSheet planting={planting} onClose={() => {}} /></ToastProvider>)
  })
}

/** The "Somewhere else" arm with a variety chosen — the state every write test starts from. */
async function openOther() {
  await open()
  fireEvent.click(screen.getByTestId('seed-origin-other'))
  fireEvent.click(screen.getByTestId('stub-pick-variety'))
  await screen.findByTestId('seed-source')
}

/** Open one picker's listbox and hand back a row resolver scoped to THAT picker's root. */
async function picker(testid) {
  const input = screen.getByTestId(testid)
  const root = input.parentElement
  await act(async () => { fireEvent.focus(input) })
  await waitFor(() => expect(root.querySelector('[data-testid="sp-panel"]')).not.toBe(null))
  return { input, root, opt: (id) => root.querySelector(`[data-testid="${testid}-opt-${id}"]`) }
}

async function choose(testid, sourceId) {
  const p = await picker(testid)
  await act(async () => { fireEvent.click(p.opt(sourceId)) })
  await screen.findByTestId(`${testid}-chip`)
}

const submit = async () => {
  await act(async () => { fireEvent.click(screen.getByTestId('save-seed-submit')) })
}

describe('V5-SEEDSOURCEPICKER-001 — the field is on the sheet, and only where it means something', () => {
  it('the "somewhere else" arm offers the KIND and the NAMED SOURCE, which are different questions', async () => {
    await openOther()
    // Both, not one instead of the other: `source_kind` is the eight-value CHECK (what kind of
    // place), `source_id` is a row in public.source (which place). Losing either half re-opens the
    // complaint from one side or the other.
    expect(screen.getByTestId('seed-source-kind').tagName).toBe('SELECT')
    const origin = screen.getByTestId('seed-source')
    expect(origin.getAttribute('role')).toBe('combobox')
    expect(origin.getAttribute('aria-label')).toBe('Origin')
  })

  it('is ABSENT on the planting-page door — own-garden provenance is source_plant_id', async () => {
    // Seed off one of our own plants already has an originator. A registry row there would assert a
    // second, different one, so this whole block must not render when the caller knew the parent.
    await open(PL)
    expect(screen.queryByTestId('seed-source')).toBe(null)
    expect(screen.queryByTestId('seed-acquired-from')).toBe(null)
  })

  it('is ABSENT on the picked-planting arm too, and comes back on the way out of it', async () => {
    await open()
    fireEvent.click(screen.getByTestId('seed-origin-plant'))
    expect(screen.queryByTestId('seed-source')).toBe(null)
    fireEvent.click(screen.getByText('← Not from one of my plants'))
    fireEvent.click(screen.getByTestId('seed-origin-other'))
    expect(screen.getByTestId('seed-source')).toBeTruthy()
  })

  it('the venue picker appears only once an origin exists', async () => {
    // Before that, "does it differ?" has nothing to differ from.
    await openOther()
    expect(screen.queryByTestId('seed-acquired-from')).toBe(null)
    await choose('seed-source', 'src-fedco')
    const acq = await screen.findByTestId('seed-acquired-from')
    expect(acq.getAttribute('aria-label')).toBe('Acquired from')
  })
})

describe('V5-SEEDSOURCEPICKER-001 — the id reaches the request body', () => {
  it('names WHICH farm stand — source_id in the POST, alongside the kind that says what sort', async () => {
    // Dave's own sentence, as a test: "I can note it is a Farm Stand, but not which."
    await openOther()
    fireEvent.change(screen.getByTestId('seed-source-kind'), { target: { value: 'farm_stand' } })
    await choose('seed-source', 'src-bardwell')
    fireEvent.change(screen.getByTestId('save-seed-name'), { target: { value: 'Reaper from the stand' } })
    await submit()

    await waitFor(() => expect(createBody()).toBeTruthy())
    const body = createBody()
    expect(body.source_id).toBe('src-bardwell')
    expect(body.source_kind).toBe('farm_stand')
    // The pair the CHECK cares about is still the shipped one: a non-garden kind and no parent.
    expect(body.source_plant_id).toBe(null)
    expect(has('acquired_from_source_id')).toBe(false)
  })

  it('a packet bought somewhere else carries BOTH ids, each its own value', async () => {
    // The genuine two-fact case the schema exists for (v5-sourceentity-001 §3): Fedco bred and
    // packed it, the co-op is where it changed hands. Asserted as two DIFFERENT ids in one body, so
    // "one overwrote the other" is a failing state rather than an invisible one.
    await openOther()
    await choose('seed-source', 'src-fedco')
    await choose('seed-acquired-from', 'src-coop')
    await submit()

    await waitFor(() => expect(createBody()).toBeTruthy())
    expect(createBody().source_id).toBe('src-fedco')
    expect(createBody().acquired_from_source_id).toBe('src-coop')
  })

  it('sends NEITHER key when no source was named — absent, not an explicit null', async () => {
    // The presence discipline the kind beside it already keeps. MUTATION: drop the `sourceId &&`
    // conditions in the payload spread and this goes red on the `false`s.
    await openOther()
    fireEvent.change(screen.getByTestId('seed-source-kind'), { target: { value: 'gift' } })
    await submit()

    await waitFor(() => expect(createBody()).toBeTruthy())
    expect(has('source_id')).toBe(false)
    expect(has('acquired_from_source_id')).toBe(false)
    expect(createBody().source_kind).toBe('gift')
  })

  it('clearing the origin drops the venue too — no orphan id reaches the body', async () => {
    // acquired_from means "the shop WHEN IT DIFFERS from the grower", so it is meaningless alone and
    // a stale id left in state would still be submitted. ONE mechanism owns this — the origin
    // picker's onChange — so neutralising it is visible here.
    await openOther()
    await choose('seed-source', 'src-fedco')
    await choose('seed-acquired-from', 'src-coop')
    await act(async () => { fireEvent.click(screen.getByLabelText('Clear origin')) })
    await waitFor(() => expect(screen.queryByTestId('seed-acquired-from')).toBe(null))
    await submit()

    await waitFor(() => expect(createBody()).toBeTruthy())
    expect(has('source_id')).toBe(false)
    expect(has('acquired_from_source_id')).toBe(false)
  })

  it('the planting arm sends neither key, whatever was typed on the way through', async () => {
    // The `!parent` gate, and the half that makes this a widening rather than a fork: choosing a
    // planting must produce the same write the planting page produces. Naming a source and THEN
    // backing out to a planting is the path that would otherwise leak one.
    await openOther()
    await choose('seed-source', 'src-fedco')
    fireEvent.click(screen.getByText('← It did come off one of my plants'))
    fireEvent.click(screen.getByTestId('seed-origin-plant'))
    fireEvent.click(screen.getByTestId('stub-pick-planting'))
    await submit()

    await waitFor(() => expect(createBody()).toBeTruthy())
    expect(createBody().source_plant_id).toBe('pl-3')
    expect(has('source_id')).toBe(false)
    expect(has('acquired_from_source_id')).toBe(false)
  })
})

describe('V5-SEEDSOURCEPICKER-001 — naming one source twice', () => {
  it('is refused HERE, before the round trip the server would 400', async () => {
    // chk_inventory_source_distinct, and sourceRefsCollide -> SOURCE_DISTINCT_ERROR in front of it.
    // NULL on acquired_from means "not recorded, or not distinct" — never "same as the origin" — so
    // this is a meaningless row, not a redundant one. Reachable because both pickers offer the whole
    // registry.
    await openOther()
    await choose('seed-source', 'src-coop')
    await choose('seed-acquired-from', 'src-coop')
    await submit()

    expect(createCall()).toBe(undefined)
    expect(screen.getByTestId('save-seed-error').textContent).toMatch(/same as the origin/i)
  })

  it('saves once the venue is cleared back off', async () => {
    // The other side of the guard: it must be an exit, not a dead end.
    await openOther()
    await choose('seed-source', 'src-coop')
    await choose('seed-acquired-from', 'src-coop')
    await submit()
    expect(createCall()).toBe(undefined)

    await act(async () => { fireEvent.click(screen.getByLabelText('Clear acquired from')) })
    await submit()
    await waitFor(() => expect(createBody()).toBeTruthy())
    expect(createBody().source_id).toBe('src-coop')
    expect(has('acquired_from_source_id')).toBe(false)
  })
})

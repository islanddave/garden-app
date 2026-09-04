// V4-SOURCEREG-001 — the source registry on the PLANT form (wiring surface 1 of 3).
//
// WHAT THIS FILE CAN AND CANNOT PROVE. PlantForm is presentational and controlled: its host owns
// the submit handler AND the payload builder, so the last thing this component decides is the PATCH
// it hands to `onChange`. That patch is therefore the payload assertion at this seam, and the tests
// below drive a real controlled host so the assertion is on the value object that actually results
// — not on a spy call in isolation, which would pass just as happily if the patch key were wrong.
//
// The hop AFTER this one is not covered here and is not covered anywhere: PlantingEditor:218/265,
// ProjectDetail:439 and CaptureFlow:464 each ENUMERATE their payload keys, and none of them names
// source_id, so the id stops at their form state today. Those three files belong to other lanes.
//
// EVERY NEEDLE IN THIS FIXTURE IS UNIQUE — 'Fedco', 'Greenfield' and 'Botanical' appear nowhere
// else in the rendered tree, and every row assertion resolves through `<picker-testid>-opt-<id>`
// (namespaced per instance, since both listboxes can be open at once) so it names
// WHICH row satisfied it rather than merely that one did. No jest-dom (L-182): plain DOM reads.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
// VarietyPicker drags useCachedFetch, the data cache and Clerk in behind it. The unit here is the
// SOURCE wiring; the stub keeps the render cheap and carries a testid so nothing keys on its copy.
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: () => <div data-testid="variety-picker-stub" />,
}))

import PlantForm from '../components/forms/PlantForm.jsx'

// The three widest real catalogue rows named in the contract, so the fixture is the live
// distribution rather than invented short names.
const SOURCES = [
  { id: 'src-botanical', name: 'Botanical Interests', kind: 'seed_company', locality: 'Broomfield, CO', address: null, website_url: null, notes: null },
  { id: 'src-fedco', name: 'Fedco Seeds', kind: 'seed_company', locality: 'Clinton, ME', address: null, website_url: null, notes: null },
  { id: 'src-coop', name: 'Greenfield Farmers Co-op', kind: 'garden_center', locality: 'Greenfield, MA', address: null, website_url: null, notes: null },
]

const EMPTY = {
  name: '', quantity: '1', variety: null, notes: '', status: '', sown_at: '', sown_at_approx: false,
  qty_initial: '', seeds_sown: '', seeds_germinated: '', source_type: '', source_ref: '',
  source_generation: '', lineage_note: '', source_id: '', acquired_from_source_id: '',
}

// A real controlled host: the patch is merged exactly as every production host merges it
// (`onChange={p => setForm(f => ({ ...f, ...p }))}`), and `submitted` is the value object at
// submit time. Asserting against THAT rather than against the spy is what makes a wrong patch key
// visible — a patch of `{ sourceId }` would still be "called", and would still be merged.
function Host({ initial = EMPTY, onSubmitSpy }) {
  const [v, setV] = React.useState(initial)
  return (
    <PlantForm
      value={v}
      onChange={p => setV(f => ({ ...f, ...p }))}
      onSubmit={e => { e.preventDefault(); onSubmitSpy(v) }}
      detailsDefaultOpen
    />
  )
}

const renderForm = async (initial) => {
  const onSubmitSpy = vi.fn()
  const utils = render(<Host initial={initial} onSubmitSpy={onSubmitSpy} />)
  await screen.findByTestId('plant-origin')
  return { onSubmitSpy, ...utils }
}

// Open a specific picker by its host testid and wait for ITS panel, then return a scoped query so
// no assertion can be satisfied by the other instance's rows.
async function openPicker(testid) {
  const input = screen.getByTestId(testid)
  const root = input.parentElement
  fireEvent.focus(input)
  await waitFor(() => expect(root.querySelector('[data-testid="sp-panel"]')).not.toBe(null))
  return { input, root, opt: (id) => root.querySelector(`[data-testid="${testid}-opt-${id}"]`) }
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((path) => {
    if (path === '/api/varieties/sources') return Promise.resolve(SOURCES)
    if (path === '/api/varieties/source-kinds') return Promise.resolve([])
    return Promise.resolve([])
  })
})

describe('PlantForm — the origin picker is on the form, inline', () => {
  it('renders the picker as a combobox with no click needed to reach it', async () => {
    await renderForm()
    const input = screen.getByTestId('plant-origin')
    expect(input.getAttribute('role')).toBe('combobox')
    expect(input.getAttribute('aria-label')).toBe('Origin')
  })

  it('does NOT replace the source_type Select — both axes are still on the form', async () => {
    await renderForm()
    // PLANT_SOURCE_OPTIONS: the TRANSACTION. Asserted by a value only that vocabulary carries.
    const typeSelect = document.getElementById('plant-source')
    expect(typeSelect.tagName).toBe('SELECT')
    const values = Array.from(typeSelect.options).map(o => o.value)
    expect(values).toContain('nursery_transplant')
    expect(values).toContain('seed_packet')
    // …and the PLACE is a separate control with its own id.
    expect(screen.getByTestId('plant-origin').id).toBe('plant-srcid')
  })

  it('KEEPS the free text, relabelled as the order/lot reference it holds', async () => {
    await renderForm()
    const ref = document.getElementById('plant-sref')
    expect(ref).not.toBe(null)
    expect(ref.tagName).toBe('INPUT')
    // The old placeholder invited a vendor name ("e.g. Johnny's Lot 4421"); the new one asks for
    // the thing with no column of its own.
    expect(ref.getAttribute('placeholder')).toContain('order no.')
    const label = document.querySelector('label[for="plant-sref"]')
    expect(label.textContent).toContain('Order / lot reference')
  })
})

describe('PlantForm — the patch that reaches the host', () => {
  it('choosing an origin puts source_id in the value the host submits, and the free text SURVIVES', async () => {
    const { onSubmitSpy } = await renderForm()

    fireEvent.change(document.getElementById('plant-sref'), { target: { value: 'order no. 350019' } })

    const origin = await openPicker('plant-origin')
    fireEvent.click(origin.opt('src-fedco'))
    await screen.findByTestId('plant-origin-chip')

    fireEvent.submit(document.querySelector('form'))
    expect(onSubmitSpy).toHaveBeenCalledTimes(1)
    const v = onSubmitSpy.mock.calls[0][0]
    expect(v.source_id).toBe('src-fedco')
    // The free text is not collateral of the picker: it still carries its own, different value.
    expect(v.source_ref).toBe('order no. 350019')
    // And the third vocabulary is untouched by either.
    expect(v.source_type).toBe('')
  })

  it('choosing an acquired-from puts acquired_from_source_id in the SAME submitted value', async () => {
    const { onSubmitSpy } = await renderForm()

    const origin = await openPicker('plant-origin')
    fireEvent.click(origin.opt('src-fedco'))
    await screen.findByTestId('plant-acquired-from')

    const acq = await openPicker('plant-acquired-from')
    fireEvent.click(acq.opt('src-coop'))
    await screen.findByTestId('plant-acquired-from-chip')

    fireEvent.submit(document.querySelector('form'))
    const v = onSubmitSpy.mock.calls[0][0]
    expect(v.source_id).toBe('src-fedco')
    expect(v.acquired_from_source_id).toBe('src-coop')
  })

  it('clearing the origin clears the venue with it — no orphan acquired_from is submitted', async () => {
    const { onSubmitSpy } = await renderForm({
      ...EMPTY, source_id: 'src-fedco', acquired_from_source_id: 'src-coop',
    })
    await screen.findByTestId('plant-acquired-from-chip')

    fireEvent.click(screen.getByRole('button', { name: 'Clear origin' }))
    await waitFor(() => expect(screen.queryByTestId('plant-acquired-from')).toBe(null))

    fireEvent.submit(document.querySelector('form'))
    const v = onSubmitSpy.mock.calls[0][0]
    expect(v.source_id).toBe('')
    expect(v.acquired_from_source_id).toBe('')
  })
})

describe('PlantForm — the venue picker appears only when it can change the answer', () => {
  it('is ABSENT before an origin is chosen and PRESENT after', async () => {
    await renderForm()
    expect(screen.queryByTestId('plant-acquired-from')).toBe(null)
    expect(document.querySelector('label[for="plant-acqid"]')).toBe(null)

    const origin = await openPicker('plant-origin')
    fireEvent.click(origin.opt('src-botanical'))

    const acq = await screen.findByTestId('plant-acquired-from')
    expect(acq.getAttribute('aria-label')).toBe('Acquired from')
    expect(document.querySelector('label[for="plant-acqid"]').textContent).toContain('Acquired from')
  })

  it('is present on first paint for a row that already carries an origin', async () => {
    await renderForm({ ...EMPTY, source_id: 'src-coop' })
    // Chip mode, so the origin reads back by NAME — proving the picker resolved the stored id.
    const chip = await screen.findByTestId('plant-origin-chip')
    expect(chip.textContent).toContain('Greenfield Farmers Co-op')
    expect(screen.getByTestId('plant-acquired-from')).not.toBe(null)
  })

  it('warns when the two name the same source (chk_plants_source_distinct)', async () => {
    await renderForm({ ...EMPTY, source_id: 'src-fedco', acquired_from_source_id: 'src-fedco' })
    const err = await screen.findByRole('alert')
    expect(err.textContent).toContain('Same as the origin')
    expect(err.id).toBe('plant-acqid-error')
  })
})

// V4-EDITCOMPLETE-001 V3 — the varieties edit surface.
//
// The two things this file has to prove, because both are the exact failure modes that shipped
// before it (BUG-HARVESTEDIT-001, then 5b430f4's two 405'ing Save buttons):
//   1. every field the form RENDERS is actually carried on the PUT body (render != persist), and
//   2. a field the user EMPTIES is really returned to NULL, not silently kept by COALESCE.
// Both are asserted against the payload the component hands to onSave, plus a full round-trip
// through a fake server that applies the documented three-way semantics.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import VarietyEditor, {
  FIELDS, buildVarietyPatch, formFromVariety, isEmptyPatch,
} from '../components/forms/VarietyEditor.jsx'

const OWNER = 'user_owner_1'

function makeVariety(over = {}) {
  return {
    id: 'v-1',
    name: 'Jalapeño',
    created_by: OWNER,
    species: 'Capsicum annuum',
    genus: 'Capsicum',
    crop_type_slug: 'pepper',
    lifecycle: 'annual',
    days_to_maturity_min: 70,
    days_to_maturity_max: 80,
    care_notes: 'Stake in wind.',
    soil_notes: null,
    sun_requirements: 'full_sun',
    common_diseases: ['blossom end rot', 'aphids'],
    expected_yield_notes: '25 pods',
    source_url: 'https://example.com/jalapeno',
    scoville_min: 2500,
    scoville_max: 8000,
    growth_habit: 'bush',
    produces_scape: false,
    determinacy: null,
    day_length_response: null,
    grown_as: 'annual',
    start_method: 'start_indoors',
    start_indoor_weeks_min: 6,
    start_indoor_weeks_max: 8,
    direct_sow_timing: null,
    sow_depth_in: 0.25,
    seed_spacing_in: 2,
    row_spacing_in: 18,
    days_to_germ_min: 7,
    days_to_germ_max: 21,
    sow_season: 'warm',
    sow_notes: 'Bottom heat helps.',
    // V5-VARIETYFACTSEDIT-001 — GET /api/varieties/:id now carries these five.
    origin_country: 'Mexico',
    origin_region: 'Veracruz',
    breeding_system: 'f1',
    breeding_source: 'vendor_catalog',
    scoville_source: 'inference',
    ...over,
  }
}

const CROP_TYPES = [
  { slug: 'pepper', display_name: 'Pepper' },
  { slug: 'tomato', display_name: 'Tomato' },
]

function renderEditor(over = {}, props = {}) {
  const variety = makeVariety(over)
  const onSave = vi.fn(async () => ({ variety }))
  const onSaved = vi.fn()
  const utils = render(
    <VarietyEditor
      variety={variety}
      cropTypes={CROP_TYPES}
      currentUserId={OWNER}
      onSave={onSave}
      onSaved={onSaved}
      onCancel={() => {}}
      {...props}
    />
  )
  return { ...utils, variety, onSave, onSaved }
}

// Open every <details> so the collapsed sections' controls are queryable.
function openAllSections(container) {
  for (const d of container.querySelectorAll('details')) d.open = true
}

describe('VarietyEditor — every rendered field reaches the wire', () => {
  it('renders a control for every table-driven field plus name and crop type', () => {
    const { container } = renderEditor()
    openAllSections(container)
    for (const { key } of FIELDS) {
      expect(
        container.querySelector(`#variety-edit-${key}`),
        `no control rendered for ${key}`
      ).toBeTruthy()
    }
    expect(container.querySelector('#variety-edit-name')).toBeTruthy()
    expect(container.querySelector('#variety-edit-crop_type_slug')).toBeTruthy()
  })

  // The anti-vacuity assertion: it is not enough that the field renders. Change each one and
  // confirm the change is on the body handed to onSave. A field that renders but is dropped from
  // the payload is the bug class 5b430f4 fixed, and it passes a "does it render" test.
  it.each(FIELDS.filter(f => f.kind === 'text' || f.kind === 'area').map(f => f.key))(
    'a typed change to %s appears on the PUT body',
    (key) => {
      const { container, variety } = renderEditor()
      openAllSections(container)
      fireEvent.change(container.querySelector(`#variety-edit-${key}`), { target: { value: 'CHANGED' } })
      const patch = buildVarietyPatch(
        { ...formFromVariety(variety), [key]: 'CHANGED' },
        variety
      )
      expect(patch[key]).toBe('CHANGED')
    }
  )
})

describe('buildVarietyPatch — the three-way contract', () => {
  it('omits untouched fields entirely (an unchanged form is an empty patch)', () => {
    const v = makeVariety()
    expect(isEmptyPatch(buildVarietyPatch(formFromVariety(v), v))).toBe(true)
  })

  it('sends a key when the value changed', () => {
    const v = makeVariety()
    const patch = buildVarietyPatch({ ...formFromVariety(v), care_notes: 'New note' }, v)
    expect(patch.care_notes).toBe('New note')
    expect(patch.clear).toBeUndefined()
  })

  // THE violation this whole item exists to close: emptying a populated field must produce an
  // explicit clear, because a bare omission is indistinguishable from "leave it alone" and the
  // Lambda's COALESCE would keep the old value forever.
  it('names an emptied populated field in clear, and does not also send it', () => {
    const v = makeVariety()
    const patch = buildVarietyPatch({ ...formFromVariety(v), care_notes: '' }, v)
    expect(patch.clear).toContain('care_notes')
    expect('care_notes' in patch).toBe(false)
  })

  it('does not clear a field that was already null (no needless write)', () => {
    const v = makeVariety({ soil_notes: null })
    const patch = buildVarietyPatch(formFromVariety(v), v)
    expect(patch.clear ?? []).not.toContain('soil_notes')
  })

  it('clears crop_type_slug when the user picks — none —', () => {
    const v = makeVariety()
    const patch = buildVarietyPatch({ ...formFromVariety(v), crop_type_slug: '' }, v)
    expect(patch.clear).toContain('crop_type_slug')
  })

  it('coerces types: int, num, csv and the tri-state boolean', () => {
    const v = makeVariety({
      days_to_maturity_min: null, sow_depth_in: null,
      common_diseases: null, produces_scape: null,
    })
    const patch = buildVarietyPatch({
      ...formFromVariety(v),
      days_to_maturity_min: '65',
      sow_depth_in: '0.5',
      common_diseases: 'rust, wilt',
      produces_scape: 'true',
    }, v)
    expect(patch.days_to_maturity_min).toBe(65)
    expect(patch.sow_depth_in).toBe(0.5)
    expect(patch.common_diseases).toEqual(['rust', 'wilt'])
    expect(patch.produces_scape).toBe(true)
  })

  // false is a real stored value, not an absence — the classic falsy-coercion bug.
  it('treats produces_scape=false as a value, not an empty field', () => {
    const v = makeVariety({ produces_scape: true })
    const patch = buildVarietyPatch({ ...formFromVariety(v), produces_scape: 'false' }, v)
    expect(patch.produces_scape).toBe(false)
    expect(patch.clear ?? []).not.toContain('produces_scape')
  })

  it('never both sends and clears the same key (the Lambda 400s on that)', () => {
    const v = makeVariety()
    const form = formFromVariety(v)
    const patch = buildVarietyPatch({ ...form, care_notes: '', soil_notes: 'x' }, v)
    for (const k of patch.clear ?? []) expect(k in patch).toBe(false)
  })
})

// ── Round-trip: edit -> save -> read back ────────────────────────────────────
// A fake server that applies exactly the semantics lambda/varieties/index.js implements
// (COALESCE keep + the clear CASE branch). Proves the payload the component builds actually
// produces the row the user asked for, which asserting on the payload alone cannot.
function applyPut(row, body) {
  const next = { ...row }
  for (const [k, val] of Object.entries(body)) {
    if (k === 'clear') continue
    if (val != null) next[k] = val
  }
  for (const k of body.clear ?? []) next[k] = null
  return next
}

describe('VarietyEditor — round-trip persistence', () => {
  let stored
  beforeEach(() => { stored = makeVariety() })

  function renderAgainstFakeServer() {
    const onSave = vi.fn(async (id, payload) => {
      stored = applyPut(stored, payload)
      return { variety: stored }
    })
    const onSaved = vi.fn()
    const utils = render(
      <VarietyEditor
        variety={stored}
        cropTypes={CROP_TYPES}
        currentUserId={OWNER}
        onSave={onSave}
        onSaved={onSaved}
        onCancel={() => {}}
      />
    )
    openAllSections(utils.container)
    return { ...utils, onSave, onSaved }
  }

  it('an edited value survives the round trip', async () => {
    const { container, onSaved } = renderAgainstFakeServer()
    fireEvent.change(container.querySelector('#variety-edit-care_notes'), {
      target: { value: 'Water deeply once a week.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(stored.care_notes).toBe('Water deeply once a week.')
  })

  it('an emptied value really becomes null after the round trip', async () => {
    const { container, onSaved } = renderAgainstFakeServer()
    expect(stored.care_notes).toBe('Stake in wind.')
    fireEvent.change(container.querySelector('#variety-edit-care_notes'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(stored.care_notes).toBeNull()
  })

  it('a corrected name survives the round trip (the write-once trap this closes)', async () => {
    const { container, onSaved } = renderAgainstFakeServer()
    fireEvent.change(container.querySelector('#variety-edit-name'), { target: { value: 'Jalapeno' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(stored.name).toBe('Jalapeno')
  })

  it('re-filing the crop type survives the round trip', async () => {
    const { container, onSaved } = renderAgainstFakeServer()
    fireEvent.change(container.querySelector('#variety-edit-crop_type_slug'), { target: { value: 'tomato' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(stored.crop_type_slug).toBe('tomato')
  })

  it('surfaces a server error and does not report success', async () => {
    const onSave = vi.fn(async () => ({ error: 'Rate limit exceeded' }))
    const onSaved = vi.fn()
    const { container } = render(
      <VarietyEditor variety={stored} cropTypes={CROP_TYPES} currentUserId={OWNER}
        onSave={onSave} onSaved={onSaved} onCancel={() => {}} />
    )
    openAllSections(container)
    fireEvent.change(container.querySelector('#variety-edit-care_notes'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Rate limit exceeded'))
    expect(onSaved).not.toHaveBeenCalled()
  })
})

describe('VarietyEditor — ownership gate', () => {
  it('is read-only for a row owned by someone else', () => {
    const { container } = renderEditor({ created_by: 'rescue-intake-longriver-20260712' })
    expect(screen.getByRole('status').textContent).toContain('read-only')
    expect(container.querySelector('#variety-edit-name').disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true)
  })

  it('is editable for a row the current user owns', () => {
    const { container } = renderEditor()
    expect(screen.queryByRole('status')).toBeNull()
    expect(container.querySelector('#variety-edit-name').disabled).toBe(false)
  })
})

describe('VarietyEditor — save gating', () => {
  it('Save is disabled until something actually changes', () => {
    const { container } = renderEditor()
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true)
    fireEvent.change(container.querySelector('#variety-edit-name'), { target: { value: 'Other' } })
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(false)
  })
})

// ── V4-CROPTYPEREACH-001: minting a crop type from the EDIT surface ─────────
// V4-CROPTYPE-001 put "＋ New crop type" in exactly one place — VarietyPicker's stage 2, which only
// runs while creating a BRAND-NEW variety. So a variety that already existed could be edited forever
// and still never get a type: this Select was a closed list. That is how "Kousa Dogwood" was still
// untyped on 2026-08-17 after its variety row had been created. These cover the second surface.
describe('VarietyEditor — inline crop-type mint (CROPTYPEREACH)', () => {
  const DOGWOOD = { slug: 'dogwood', display_name: 'Dogwood', default_lifecycle: 'perennial', category: 'ornamental' }

  it('offers the mint affordance when the page supplies onCreateCropType', () => {
    renderEditor({}, { onCreateCropType: vi.fn() })
    expect(screen.getByText(/New crop type/)).toBeDefined()
  })

  it('omits it when no creator is wired, rather than rendering a dead control', () => {
    renderEditor()
    expect(screen.queryByText(/New crop type/)).toBeNull()
  })

  it('hides it for a row this user cannot edit — a mint there would be a save that 404s', () => {
    renderEditor({ created_by: 'user_someone_else' }, { onCreateCropType: vi.fn() })
    expect(screen.queryByText(/New crop type/)).toBeNull()
  })

  it('minting selects the new type AND carries it onto the PUT body', async () => {
    const onCreateCropType = vi.fn(async () => ({ cropType: DOGWOOD }))
    // Start from a variety with NO type — the Kousa case exactly.
    const { onSave, container } = renderEditor({ crop_type_slug: null }, { onCreateCropType })

    fireEvent.click(screen.getByText(/New crop type/))
    fireEvent.change(screen.getByPlaceholderText('e.g. Dogwood'), { target: { value: 'Dogwood' } })
    fireEvent.click(screen.getByText('Create crop type'))

    await waitFor(() => expect(onCreateCropType).toHaveBeenCalled())
    expect(onCreateCropType.mock.calls[0][0].display_name).toBe('Dogwood')

    // The mint closes and the new slug is SELECTED — not left for the user to hunt in a 141-row list.
    await waitFor(() => expect(screen.getByLabelText(/Crop type/).value).toBe('dogwood'))

    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][1].crop_type_slug).toBe('dogwood')
  })

  it('the mint button does not submit the variety form (it lives inside it)', async () => {
    const onCreateCropType = vi.fn(async () => ({ cropType: DOGWOOD }))
    const { onSave, container } = renderEditor({ crop_type_slug: null }, { onCreateCropType })
    fireEvent.click(screen.getByText(/New crop type/))
    fireEvent.change(screen.getByPlaceholderText('e.g. Dogwood'), { target: { value: 'Dogwood' } })
    fireEvent.click(screen.getByText('Create crop type'))
    await waitFor(() => expect(onCreateCropType).toHaveBeenCalled())
    expect(onSave).not.toHaveBeenCalled()
  })

  it('a server steer to an existing type offers adopting it, and adopting selects that slug', async () => {
    // "Chili" is another word for the existing "Pepper" type; a duplicate would silently lose the
    // derived facets, so the server 409s with `existing` and the UI must offer the adopt.
    const onCreateCropType = vi.fn(async () => ({
      error: '"Chili" is another name for the existing "Pepper" crop type',
      existing: { slug: 'pepper', display_name: 'Pepper' },
    }))
    renderEditor({ crop_type_slug: null }, { onCreateCropType })

    fireEvent.click(screen.getByText(/New crop type/))
    fireEvent.change(screen.getByPlaceholderText('e.g. Dogwood'), { target: { value: 'Chili' } })
    fireEvent.click(screen.getByText('Create crop type'))

    await waitFor(() => screen.getByRole('alert'))
    fireEvent.click(screen.getByText(/Use "Pepper"/))
    await waitFor(() => expect(screen.getByLabelText(/Crop type/).value).toBe('pepper'))
  })
})

// ── V5-VARIETYFACTSEDIT-001: origin, breeding and heat source ───────────────
// Dave: "Today none is editable, and an edited Scoville figure keeps its 'est.' mark until the source
// changes." The card prints "est." when scoville_source = 'inference', and nothing could change that
// column. These pin the five new FIELDS rows end to end, plus the one rule the form enforces itself:
// a breeding call is never sent without its source (chk_plant_varieties_breeding_sourced).
describe('VarietyEditor — origin, breeding and heat source (VARIETYFACTSEDIT)', () => {
  const NEW_KEYS = ['origin_country', 'origin_region', 'scoville_source', 'breeding_system', 'breeding_source']
  const field = (key) => FIELDS.find(f => f.key === key)
  const UNSET = { origin_country: null, origin_region: null, scoville_source: null, breeding_system: null, breeding_source: null }
  const PAIRING_MSG = '"Breeding info from" is required when Breeding is set.'

  function renderRoundTrip(over = {}) {
    const box = { stored: makeVariety(over) }
    const onSave = vi.fn(async (id, payload) => {
      box.stored = applyPut(box.stored, payload)
      return { variety: box.stored }
    })
    const onSaved = vi.fn()
    const utils = render(
      <VarietyEditor variety={box.stored} cropTypes={CROP_TYPES} currentUserId={OWNER}
        onSave={onSave} onSaved={onSaved} onCancel={() => {}} />
    )
    openAllSections(utils.container)
    return { ...utils, box, onSave, onSaved }
  }
  const change = (container, key, value) =>
    fireEvent.change(container.querySelector(`#variety-edit-${key}`), { target: { value } })
  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  it('shows origin in the always-open identity rows and the rest under Classification', () => {
    const { container } = renderEditor()
    for (const key of ['origin_country', 'origin_region']) {
      const el = container.querySelector(`#variety-edit-${key}`)
      expect(el, `${key} rendered`).toBeTruthy()
      expect(el.closest('details'), `${key} must not sit in a collapsed section`).toBeNull()
    }
    const classify = container.querySelector('[data-testid="variety-section-classify"]')
    for (const key of ['scoville_source', 'breeding_system', 'breeding_source']) {
      expect(classify.querySelector(`#variety-edit-${key}`), `${key} under Classification`).toBeTruthy()
    }
  })

  it('puts "Heat figure from" directly after the two Scoville numbers', () => {
    const keys = FIELDS.map(f => f.key)
    const i = keys.indexOf('scoville_max')
    expect(keys.slice(i - 1, i + 2)).toEqual(['scoville_min', 'scoville_max', 'scoville_source'])
  })

  it('labels every new field in plain English', () => {
    expect(NEW_KEYS.map(k => [k, field(k)?.label])).toEqual([
      ['origin_country', 'Country of origin'],
      ['origin_region', 'Region of origin'],
      ['scoville_source', 'Heat figure from'],
      ['breeding_system', 'Breeding'],
      ['breeding_source', 'Breeding info from'],
    ])
    expect(field('breeding_system').options).toEqual([
      ['f1', 'F1 hybrid'], ['open_pollinated', 'Open-pollinated'], ['landrace', 'Landrace'], ['unknown', 'Unknown'],
    ])
    expect(field('scoville_source').options).toEqual([
      ['packet_label', 'Seed packet'], ['vendor_catalog', "Supplier's catalog"], ['breeder', 'Breeder'],
      ['reference_work', 'Reference book or site'], ['grower_record', 'My own record'],
      ['inference', 'Best guess (shows est.)'],
    ])
    // Only a heat figure has an "est." to show; nothing renders breeding_source.
    expect(Object.fromEntries(field('breeding_source').options).inference).toBe('Best guess')
  })

  // src/ must not import lambda/, so the server's vocabulary is read off disk (clearKeys.test.js's
  // approach). An option the server does not accept is a Save that 400s and loses every other edit.
  it('offers exactly the values the server validates, no more and no fewer', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(here, '../../lambda/varieties/validate.js'), 'utf8')
    const list = (name) => {
      const m = src.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\];`))
      expect(m, `validate.js no longer declares ${name}`).toBeTruthy()
      return [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map(x => x[1])
    }
    const values = (key) => field(key).options.map(([v]) => v)
    expect(values('breeding_system')).toEqual(list('VALID_BREEDING_SYSTEM'))
    expect(values('breeding_source')).toEqual(list('VALID_FACT_SOURCE'))
    expect(values('scoville_source')).toEqual(list('VALID_FACT_SOURCE'))
  })

  it('seeds the form from the stored values rather than empty boxes', () => {
    const { container } = renderRoundTrip()
    for (const key of NEW_KEYS) {
      expect(container.querySelector(`#variety-edit-${key}`).value, key).toBe(String(makeVariety()[key]))
    }
  })

  it('a changed heat source survives the round trip — the stuck "est." this item exists for', async () => {
    const { container, box, onSaved } = renderRoundTrip({ scoville_source: 'inference' })
    change(container, 'scoville_source', 'packet_label')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(box.stored.scoville_source).toBe('packet_label')
  })

  it('all five set from empty survive the round trip', async () => {
    const { container, box, onSave, onSaved } = renderRoundTrip(UNSET)
    change(container, 'origin_country', '  Italy  ')
    change(container, 'origin_region', 'Liguria')
    change(container, 'scoville_source', 'grower_record')
    change(container, 'breeding_system', 'landrace')
    change(container, 'breeding_source', 'reference_work')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    // Trimmed on the wire, not just in the stored row.
    expect(onSave.mock.calls[0][1].origin_country).toBe('Italy')
    expect(NEW_KEYS.map(k => box.stored[k])).toEqual(['Italy', 'Liguria', 'grower_record', 'landrace', 'reference_work'])
  })

  it('all five emptied are named in clear and come back null', async () => {
    const { container, box, onSave, onSaved } = renderRoundTrip()
    for (const key of NEW_KEYS) change(container, key, '')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const payload = onSave.mock.calls[0][1]
    expect([...payload.clear].sort()).toEqual([...NEW_KEYS].sort())
    for (const key of NEW_KEYS) {
      expect(key in payload, `${key} must be cleared, not sent`).toBe(false)
      expect(box.stored[key], key).toBeNull()
    }
  })

  it('Breeding without "Breeding info from" is stopped with a message and never sent', async () => {
    const { container, onSave, onSaved } = renderRoundTrip({ breeding_system: null, breeding_source: null })
    change(container, 'breeding_system', 'f1')
    save()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(PAIRING_MSG))
    expect(onSave).not.toHaveBeenCalled()

    change(container, 'breeding_source', 'packet_label')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(onSave.mock.calls[0][1]).toMatchObject({ breeding_system: 'f1', breeding_source: 'packet_label' })
  })

  it('emptying the source under an existing breeding call is stopped the same way', async () => {
    const { container, onSave } = renderRoundTrip()
    change(container, 'breeding_source', '')
    save()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(PAIRING_MSG))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('emptying Breeding alone saves — a source may stand without a breeding call', async () => {
    const { container, onSave, onSaved } = renderRoundTrip()
    change(container, 'breeding_system', '')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(onSave.mock.calls[0][1].clear).toEqual(['breeding_system'])
  })

  it("the server's Open-pollinated refusal is shown, not reported as saved", async () => {
    // chk_plant_varieties_op_requires_cultivar: the editor cannot see variety_rank, so this one is
    // the server's to refuse, by name, before the UPDATE.
    const refusal = 'breeding_system open_pollinated can only be recorded on a single named cultivar '
      + '(variety_rank cultivar), and this variety is not recorded as one'
    const onSave = vi.fn(async () => ({ error: refusal }))
    const onSaved = vi.fn()
    const { container } = render(
      <VarietyEditor variety={makeVariety()} cropTypes={CROP_TYPES} currentUserId={OWNER}
        onSave={onSave} onSaved={onSaved} onCancel={() => {}} />
    )
    openAllSections(container)
    change(container, 'breeding_system', 'open_pollinated')
    save()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(refusal))
    expect(onSave.mock.calls[0][1].breeding_system).toBe('open_pollinated')
    expect(onSaved).not.toHaveBeenCalled()
  })
})

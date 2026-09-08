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
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import VarietyEditor, {
  FIELDS, buildVarietyPatch, formFromVariety, isEmptyPatch,
  canEditVariety, MANAGED_PRINCIPAL_PATTERNS,
} from '../components/forms/VarietyEditor.jsx'
import { P } from '../lib/constants.js'

const OWNER = 'user_owner_1'
// The other household member's sub. The server accepts Dave's edits to this row
// (created_by = ANY(household)); the client has no household roster, so the form still gates it.
// Named so the residual is visible in the test file, not just in a source comment.
const OTHER_HUMAN = 'user_household_member_2'

// Ancestor-aware visibility, because `offsetParent` has already misled a lane on this codebase and
// jsdom reports it as null for everything anyway. This walks for the three ways a node is present in
// the DOM and unreadable: a closed <details> that is not the summary, display:none, and
// visibility:hidden/opacity:0. It CANNOT speak to pixels — jsdom has no layout engine, so
// getBoundingClientRect is all zeros here and asserting on it would be a fake instrument. The 390px
// legibility claim rests on the computed-style deltas asserted further down, plus the real-browser
// measurement in project-state/_lane-varietyeditdrive-20260908.md.
// jsdom normalizes every colour to `rgb(r, g, b)`, so the palette hex has to be converted before it
// can be compared. Written against P rather than against literals: a palette retune must move the
// assertion with it, not red it.
function hexToRgb(hex) {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

function hiddenReason(el) {
  if (!el) return 'element not found'
  if (!el.ownerDocument.contains(el)) return 'not in the document'
  for (let n = el; n; n = n.parentElement) {
    if (n.tagName === 'DETAILS' && !n.open) {
      const summary = n.querySelector(':scope > summary')
      if (!(summary && (summary === el || summary.contains(el)))) return 'inside a closed <details>'
    }
    const cs = n.ownerDocument.defaultView.getComputedStyle(n)
    if (cs.display === 'none') return `ancestor <${n.tagName.toLowerCase()}> has display:none`
    if (cs.visibility === 'hidden') return `ancestor <${n.tagName.toLowerCase()}> has visibility:hidden`
    if (cs.opacity === '0') return `ancestor <${n.tagName.toLowerCase()}> has opacity:0`
  }
  return null
}

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
  it('renders a control for all 28 table-driven fields plus name and crop type', () => {
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

// ── BUG-VARIETYEDITSTRICTER-001 — the client's prediction must not be stricter than the server ──
// The gate read `created_by === currentUserId` while lambda/varieties/index.js:714-715 accepts
// `created_by = ANY(household) OR created_by LIKE ANY(managedPatterns)`. Measured on live prod
// 2026-09-08 via garden_ro: of 490 live cultivars the API lets a household member edit all 490 and
// the component allowed 467 — 23 rows shown as read-only that the server would have saved, every
// one of them attached to a live planting and therefore reachable through the door.
//
// The old test in this slot asserted the DEFECT (`created_by: 'rescue-intake-longriver-20260712'`
// -> read-only). It is not deleted for being wrong about markup; it is replaced because the
// decision it encoded has been overturned by prod evidence.
describe('VarietyEditor — the ownership predicate mirrors the API', () => {
  // INSTRUMENT CHECK first: every assertion below is about a list, so prove the list is the one the
  // Lambda has. Compared as a SET against the literal spelling in lambda/varieties/authz.js.
  it('carries the Lambda\'s four managed-principal patterns, verbatim', () => {
    expect([...MANAGED_PRINCIPAL_PATTERNS].sort()).toEqual(
      ['data-audit-%', 'data-correction-%', 'rescue-intake-%', 'system'].sort(),
    )
  })

  // The four prod principals by their REAL created_by values (measured: rescue-intake 15 rows,
  // data-audit 5, data-correction 1, system 1 = the 22 managed rows of the 23).
  it.each([
    ['rescue-intake-longriver-20260712', 15],
    ['data-audit-20260706', 5],
    ['data-correction-2026-07-07', 1],
    ['system', 1],
  ])('%s is editable — the server accepts it (%i live rows)', (createdBy) => {
    expect(canEditVariety({ created_by: createdBy }, OWNER)).toBe(true)
  })

  it('a managed-principal row renders an EDITABLE form, not a read-only one', () => {
    const { container } = renderEditor({ created_by: 'rescue-intake-longriver-20260712' })
    expect(screen.queryByTestId('variety-readonly-notice')).toBeNull()
    expect(container.querySelector('#variety-edit-genus').disabled).toBe(false)
  })

  it('a managed-principal row can actually be saved — the whole point of widening', async () => {
    const { container, onSave } = renderEditor({ created_by: 'data-audit-20260706', genus: null })
    fireEvent.change(container.querySelector('#variety-edit-genus'), { target: { value: 'Cornus' } })
    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][1].genus).toBe('Cornus')
  })

  // The prefix patterns are prefixes, not the four literal ids — the next intake batch must be
  // editable on arrival. A test pinned to today's four ids would pass while that broke.
  it('a FUTURE intake batch matches the prefix, not just today\'s ids', () => {
    expect(canEditVariety({ created_by: 'rescue-intake-eastfield-20271130' }, OWNER)).toBe(true)
  })

  // Fail direction. `system` is an exact match in the SQL, not `system%` — a stranger who managed to
  // get `systematic-scraper` into created_by must not inherit the managed arm.
  it('does not widen past the patterns: a lookalike principal stays gated', () => {
    expect(canEditVariety({ created_by: 'systematic-scraper' }, OWNER)).toBe(false)
    expect(canEditVariety({ created_by: 'x-rescue-intake-1' }, OWNER)).toBe(false)
  })

  it('a row owned by another human is still gated — the client has no household roster', () => {
    // KNOWN RESIDUAL, recorded rather than guessed around: the server WOULD accept this (the other
    // sub is in GARDEN_HOUSEHOLD_IDS) but that env var is Lambda-side with no VITE_ counterpart, so
    // the client cannot tell a household member from a stranger. Exactly 1 live prod row
    // ("Baby Spinach"). Closing it needs a can_edit flag on the GET.
    expect(canEditVariety({ created_by: OTHER_HUMAN }, OWNER)).toBe(false)
  })

  it('is editable for a row the current user owns, and for an unauthenticated/ownerless row', () => {
    expect(canEditVariety({ created_by: OWNER }, OWNER)).toBe(true)
    expect(canEditVariety({ created_by: OTHER_HUMAN }, null)).toBe(true)
    expect(canEditVariety({ created_by: null }, OWNER)).toBe(true)
  })
})

// ── BUG-VARIETYREADONLYINVISIBLE-001 — a read-only form that looked editable ────────────────────
// Driven at a genuine 390×844 (lane varietyeditdrive-20260908): "the disabled inputs barely look
// disabled — the value renders in full black on a near-identical white box; only the notice at the
// top explains it. A user who scrolls past the notice sees a normal-looking field that silently
// does nothing." Both halves are guarded here: the notice must READ as a blocker, and the fields
// must LOOK inert on their own.
describe('VarietyEditor — the read-only state says so', () => {
  const readOnly = (props = {}) => renderEditor({ created_by: OTHER_HUMAN }, props)

  it('renders the notice, and it is genuinely reachable — not in a closed <details>', () => {
    const { container } = readOnly()
    const notice = screen.getByTestId('variety-readonly-notice')
    expect(hiddenReason(notice)).toBeNull()
    // BEFORE the user tries: it must precede every control in DOM order, not sit under the Save
    // button where a 390px viewport puts it four scrolls down.
    const first = container.querySelector('input, select, textarea')
    expect(first).toBeTruthy()
    expect(notice.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('names the blocker in its own words, and no longer claims owner-only', () => {
    readOnly()
    const notice = screen.getByTestId('variety-readonly-notice')
    expect(notice.textContent).toContain("you can't edit this variety")
    expect(notice.textContent).toContain(OTHER_HUMAN)
    // The old copy said "only accepts edits from the row's owner". That is false since
    // V4-VARIETYHOUSEHOLD-001 and it is the sentence that made the widening look intended.
    expect(notice.textContent).not.toContain("row's owner")
  })

  it('uses the house WARNING surface, not the cream hint chrome it was mistaken for', () => {
    readOnly()
    const cs = getComputedStyle(screen.getByTestId('variety-readonly-notice'))
    expect(cs.backgroundColor).toBe(hexToRgb(P.warn))
    expect(cs.borderColor).toBe(hexToRgb(P.warnBorder))
    // The exact chrome it used to carry, and the reason it read as help text on a cream page.
    expect(cs.backgroundColor).not.toBe(hexToRgb(P.cream))
  })

  // THE assertion the old suite could not make. `disabled` proves the browser will refuse the
  // keystroke; it proves nothing about whether the user can SEE that before spending one. Every
  // channel is compared against the same control in the editable render, so this reds if the
  // read-only style is dropped OR if it is quietly set to the editable value.
  it.each(['name', 'genus', 'species', 'crop_type_slug'])(
    '%s is visibly inert, not just functionally inert',
    (key) => {
      const { container: ro } = readOnly()
      const disabledCs = getComputedStyle(ro.querySelector(`#variety-edit-${key}`))
      cleanup()
      const { container: rw } = renderEditor()
      const enabledCs = getComputedStyle(rw.querySelector(`#variety-edit-${key}`))

      expect(disabledCs.backgroundColor).not.toBe(enabledCs.backgroundColor)
      expect(disabledCs.color).not.toBe(enabledCs.color)
      // Shape, not colour alone — survives greyscale and every colour-vision deficiency.
      expect(disabledCs.borderStyle).toBe('dashed')
      expect(enabledCs.borderStyle).not.toBe('dashed')
      expect(disabledCs.cursor).toBe('not-allowed')
    },
  )

  // A behavioural guard, deliberately NOT `expect(saveButton.disabled).toBe(true)`: jsdom silently
  // no-ops a click on a disabled button, so that assertion passes even with handleSubmit's guard
  // deleted, and the failure would name the waitFor rather than the click. Submitting the FORM runs
  // handleSubmit for real — which is also what Enter in a text field does on a live page.
  //
  // It has to be DIRTY first or the test is vacuous: an untouched form short-circuits on
  // `isEmptyPatch` before the ownership check is ever reached, so deleting `!canEdit` leaves it
  // green. Measured — that is exactly what the first draft of this test did.
  //
  // The setup is a REAL race on this surface, not a contrivance. VarietyEdit passes
  // `currentUserId={auth?.user?.id ?? null}`, which is null until Clerk resolves, and a null
  // currentUserId renders the form EDITABLE. So a user can open a foreign variety, start typing
  // while auth is still in flight, and have the row turn out not to be theirs mid-edit. The
  // ownership check in the submit handler is the only thing standing between that and a 404 save.
  it('refuses a DIRTY save when ownership resolves against the user mid-edit', async () => {
    const variety = makeVariety({ created_by: OTHER_HUMAN })
    const onSave = vi.fn(async () => ({ variety }))
    const onSaved = vi.fn()
    const { container, rerender } = render(
      <VarietyEditor variety={variety} cropTypes={CROP_TYPES} currentUserId={null}
        onSave={onSave} onSaved={onSaved} onCancel={() => {}} />
    )
    fireEvent.change(container.querySelector('#variety-edit-genus'), { target: { value: 'Cornus' } })
    // Sanity: the form really IS dirty now, so the empty-patch branch cannot be what saves us.
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(false)

    rerender(
      <VarietyEditor variety={variety} cropTypes={CROP_TYPES} currentUserId={OWNER}
        onSave={onSave} onSaved={onSaved} onCancel={() => {}} />
    )
    expect(screen.getByTestId('variety-readonly-notice')).toBeTruthy()

    fireEvent.submit(container.querySelector('form'))
    await Promise.resolve()
    expect(onSave).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('an editable row shows no notice at all', () => {
    renderEditor()
    expect(screen.queryByTestId('variety-readonly-notice')).toBeNull()
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

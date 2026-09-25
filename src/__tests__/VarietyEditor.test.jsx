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
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import VarietyEditor, {
  FIELDS, buildVarietyPatch, formFromVariety, isEmptyPatch,
  canEditVariety, MANAGED_PRINCIPAL_PATTERNS,
} from '../components/forms/VarietyEditor.jsx'
import { P } from '../lib/constants.js'
import { SUN_OPTIONS } from '../lib/varietySpec.js'

const OWNER = 'user_owner_1'
// The other household member's sub. The server accepts Dave's edits to this row
// (created_by = ANY(household)); the editor consumes no household roster, so the form still gates
// it. Named so the residual is visible in the test file, not just in a source comment.
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

// ── BUG-VARIETYEDITSTRICTER-001 — the client's prediction must not be stricter than the server ──
// The gate read `created_by === currentUserId` while the PUT and DELETE in
// lambda/varieties/index.js accept `created_by = ANY(household) OR created_by LIKE
// ANY(managedPatterns)`. Measured on live prod 2026-09-08 via garden_ro: 23 of 490 live cultivars
// shown read-only to Dave that the server would have saved. Re-measured 2026-09-23 (read-only):
// 25 of 497 — 24 managed-principal rows plus 1 the other household member created.
//
// The old test in this slot asserted the DEFECT (`created_by: 'rescue-intake-longriver-20260712'`
// -> read-only). It is kept further down with its fixture corrected, because the decision it
// encoded has been overturned by prod evidence; its assertions still hold for a row the client
// genuinely cannot predict.
const HERE = dirname(fileURLToPath(import.meta.url))
const readLambda = (rel) => readFileSync(resolve(HERE, '../../lambda/varieties', rel), 'utf8')

describe('VarietyEditor — the ownership predicate mirrors the API', () => {
  // INSTRUMENT CHECK first: every assertion below is about a list, so prove the list is the one the
  // Lambda has — read off disk (src/ must not import lambda/; the vocabulary test below reads
  // validate.js the same way), compared in ORDER, so a pattern added to or dropped from either copy
  // reds here instead of quietly re-opening the stricter-than-the-server gap.
  it('carries the Lambda\'s managed-principal patterns, verbatim — read from authz.js', () => {
    const m = readLambda('authz.js').match(/export const MANAGED_PRINCIPAL_PATTERNS = \[([\s\S]*?)\];/)
    expect(m, 'authz.js no longer declares MANAGED_PRINCIPAL_PATTERNS — re-derive the mirror').toBeTruthy()
    const lambda = [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1])
    expect(lambda.length, 'parsed an empty list — the parse, not the Lambda, is broken').toBeGreaterThan(0)
    expect(MANAGED_PRINCIPAL_PATTERNS).toEqual(lambda)
  })

  // matchesManagedPrincipal emulates LIKE with prefix/equality. That is exact ONLY while every
  // pattern is literal text plus at most one trailing `%` — a `_` (single-char wildcard) or a
  // leading/interior `%` would make the emulation a different rule from the SQL.
  it('every pattern is one the prefix/equality emulation reads exactly as LIKE does', () => {
    for (const p of MANAGED_PRINCIPAL_PATTERNS) {
      expect(p, `${p} needs a real LIKE emulation`).toMatch(/^[^%_\\]+%?$/)
    }
  })

  // The mirror predicts ONE server predicate. If the Lambda's write scope gains, loses or rewrites
  // an arm, this reds and the mirror has to be re-derived — the lane that found this bug found it
  // because nobody re-derived the client when the server widened.
  it('the PUT and DELETE still scope writes with exactly the two arms this mirror predicts', () => {
    const src = readLambda('index.js')
    expect(src).toMatch(/const household = householdScope\(userId\);/)
    expect(src).toMatch(/const managedPatterns = managedPrincipalPatterns\(household\);/)
    // Each handler runs from its own `if (method === …)` to the next landmark AFTER it — every other
    // route in the file also ends in `return resp(405`, so an unanchored search would slice nothing.
    const putAt = src.indexOf("if (method === 'PUT') {")
    const delAt = src.indexOf("if (method === 'DELETE') {", putAt)
    const endAt = src.indexOf('return resp(405', delAt)
    expect(putAt, 'PUT handler not found').toBeGreaterThan(-1)
    expect(delAt, 'DELETE handler not found after the PUT').toBeGreaterThan(putAt)
    expect(endAt, 'no 405 after the DELETE').toBeGreaterThan(delAt)
    for (const [verb, block] of [['PUT', src.slice(putAt, delAt)], ['DELETE', src.slice(delAt, endAt)]]) {
      const arms = [...block.matchAll(/created_by\s+(?:=|LIKE)\s+ANY\([^)]*\)(?:::text\[\])?/g)].map(x => x[0])
      expect(arms.length, `${verb}: no created_by arms found`).toBeGreaterThan(0)
      expect([...new Set(arms)].sort(), verb).toEqual([
        'created_by = ANY(${household})',
        'created_by LIKE ANY(${managedPatterns}::text[])',
      ])
      // No third condition on created_by (an owner-only `= ${userId}` creeping back, or a new arm).
      expect(block.match(/created_by\s*(?:=|<>|!=|LIKE|IN|IS)\s/g).length, verb).toBe(arms.length)
    }
  })

  // The four prod principals by their REAL created_by values (re-measured 2026-09-23: rescue-intake
  // 15 rows, data-audit 5, system 3, data-correction 1 = the 24 managed rows of the 25).
  it.each([
    ['rescue-intake-longriver-20260712', 15],
    ['data-audit-20260706', 5],
    ['system', 3],
    ['data-correction-2026-07-07', 1],
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

  it('a row owned by another human is still gated — the editor has no household roster', () => {
    // KNOWN RESIDUAL, recorded rather than guessed around: the server WOULD accept this (the other
    // sub is in GARDEN_HOUSEHOLD_IDS) but that env var is Lambda-side with no VITE_ counterpart and
    // the editor does not consume GET /api/members, so it cannot tell a household member from a
    // stranger. Live prod 2026-09-23: 1 row from Dave's side ("Baby Spinach"), 472 from the other
    // member's side. Closing it means feeding the members roster in, or a can_edit flag on the GET.
    expect(canEditVariety({ created_by: OTHER_HUMAN }, OWNER)).toBe(false)
  })

  it('is editable for a row the current user owns, and for an unauthenticated/ownerless row', () => {
    expect(canEditVariety({ created_by: OWNER }, OWNER)).toBe(true)
    expect(canEditVariety({ created_by: OTHER_HUMAN }, null)).toBe(true)
    expect(canEditVariety({ created_by: null }, OWNER)).toBe(true)
  })

  // The two tests that stood here at dev 3eeccec, kept through the render. The first one's fixture
  // WAS the defect (a rescue-intake row asserted read-only — a row the server accepts), so it now
  // points at a row the client genuinely cannot predict; its three assertions are unchanged except
  // that the headline capitalises "Read-only".
  it('is read-only for a row owned by someone else', () => {
    const { container } = renderEditor({ created_by: OTHER_HUMAN })
    expect(screen.getByRole('status').textContent).toMatch(/read-only/i)
    expect(container.querySelector('#variety-edit-name').disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true)
  })

  it('is editable for a row the current user owns', () => {
    const { container } = renderEditor()
    expect(screen.queryByRole('status')).toBeNull()
    expect(container.querySelector('#variety-edit-name').disabled).toBe(false)
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
    expect(notice.textContent).toContain('nothing you type here will save')
    // The old copy said "only accepts edits from the row's owner". That is false since
    // V4-VARIETYHOUSEHOLD-001 and it is the sentence that made the widening look intended.
    expect(notice.textContent).not.toContain("row's owner")
    // Nor may it predict the server at all. This fixture IS the live case — a row the other
    // household member created — and the server would SAVE it, so "the server will refuse" is as
    // false as the sentence it replaced. The notice says what this screen does; the server is not
    // something the client can speak for here.
    expect(notice.textContent).not.toMatch(/server/i)
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

  // FIELD COVERAGE BY ENUMERATION, not by list. The it.each above names four controls; this walks
  // every control the read-only render actually produces — form.elements, which includes the ones
  // inside the collapsed <details> sections and anything a later slice adds OUTSIDE the FIELDS
  // table — so a new field cannot ship looking editable on a read-only row because nobody added it
  // to a hand-written list. V5-VARIETYFACTSEDIT-001 added five fields after the lane that wrote the
  // it.each above; they are covered here without being named.
  it('every control the form renders is disabled AND visibly inert — found by walking the form', () => {
    const snap = (form) => [...form.elements].map(el => {
      const cs = getComputedStyle(el)
      return {
        id: el.id, tag: el.tagName.toLowerCase(), text: el.textContent.trim(), disabled: el.disabled,
        backgroundColor: cs.backgroundColor, color: cs.color, borderStyle: cs.borderStyle, cursor: cs.cursor,
      }
    })
    const ENTRY = ['input', 'select', 'textarea']
    // onCreateCropType is wired on both renders, so the mint controls WOULD render if the read-only
    // branch forgot to hide them.
    const { container: ro } = readOnly({ onCreateCropType: vi.fn() })
    const roForm = ro.querySelector('form')
    const readOnlyControls = snap(roForm)
    // Controls that are not form elements at all: a contenteditable or an ARIA widget built from
    // divs would escape form.elements, so they are swept separately and must be disabled too.
    for (const w of roForm.querySelectorAll(
      '[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], '
      + '[role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="spinbutton"], '
      + '[role="listbox"], [role="searchbox"]')) {
      expect(w.disabled === true || w.getAttribute('aria-disabled') === 'true',
        `${w.outerHTML.slice(0, 80)} is live`).toBe(true)
    }
    cleanup()
    const { container: rw } = renderEditor({}, { onCreateCropType: vi.fn() })
    const editableById = new Map(snap(rw.querySelector('form')).filter(c => c.id).map(c => [c.id, c]))

    // Non-vacuity: the walk must reach every table-driven field, the collapsed sections included,
    // and the two rendered outside the table.
    const reached = new Set(readOnlyControls.map(c => c.id).filter(Boolean))
    for (const key of ['name', 'crop_type_slug', ...FIELDS.map(f => f.key)]) {
      expect(reached.has(`variety-edit-${key}`), `the walk never reached ${key}`).toBe(true)
    }

    const entry = readOnlyControls.filter(c => ENTRY.includes(c.tag))
    expect(entry.length).toBeGreaterThanOrEqual(FIELDS.length + 2)
    for (const c of entry) {
      const what = c.id || `<${c.tag}> with no id`
      expect(c.id, `${what}: a data-entry control outside Field's htmlFor wiring`).toBeTruthy()
      expect(c.disabled, `${what} is not disabled`).toBe(true)
      expect(c.borderStyle, `${what} has no dashed border`).toBe('dashed')
      expect(c.cursor, `${what} has no not-allowed cursor`).toBe('not-allowed')
      const live = editableById.get(c.id)
      expect(live, `${what} is missing from the editable render`).toBeTruthy()
      expect(live.borderStyle, `${what}: the EDITABLE render is dashed too`).not.toBe('dashed')
      expect(c.backgroundColor, `${what} has the editable fill`).not.toBe(live.backgroundColor)
      expect(c.color, `${what} has the editable ink`).not.toBe(live.color)
    }

    // Everything else form.elements holds is a button. Only Cancel — navigation, not an edit — may
    // stay live; the mint controls must be gone outright.
    for (const c of readOnlyControls.filter(c => !ENTRY.includes(c.tag))) {
      if (c.tag === 'button' && c.text === 'Cancel') { expect(c.disabled).toBe(false); continue }
      expect(c.disabled, `<${c.tag}> "${c.text}" is live on a read-only form`).toBe(true)
    }
    expect(readOnlyControls.some(c => /New crop type/.test(c.text))).toBe(false)
  })

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

  // The table above is data; this is what reaches the screen. A renderer that printed the raw value
  // (open_pollinated, inference) would pass every FIELDS assertion.
  it('renders those labels, not the stored values, as the dropdown choices', () => {
    const { container } = renderRoundTrip()
    openAllSections(container)
    const shown = (key) => [...container.querySelector(`select[id$="-${key}"]`).options]
      .filter(o => o.value !== '').map(o => o.textContent)
    expect(shown('breeding_system')).toEqual(['F1 hybrid', 'Open-pollinated', 'Landrace', 'Unknown'])
    expect(shown('scoville_source')).toEqual([
      'Seed packet', "Supplier's catalog", 'Breeder', 'Reference book or site', 'My own record', 'Best guess (shows est.)',
    ])
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
    // the server's to refuse (only for a recorded non-cultivar rank), in plain English, before the
    // UPDATE. Text as lambda/varieties/validate.js breedingPairingError words it for a market class.
    const refusal = 'Open-pollinated applies only to a single named variety, and this entry is recorded as '
      + 'a market class (a group of similar varieties).'
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

// 2026-09-25: the planting screens printed the stored Sun code ('full_sun') while this pick-list showed
// words. Both now read lib/varietySpec.js, so the word picked here is the word shown on the planting.
describe('VarietyEditor — Sun reads the app-wide Sun list', () => {
  it('the pick-list IS SUN_OPTIONS, not a copy that could drift from the display side', () => {
    expect(FIELDS.find(f => f.key === 'sun_requirements').options).toBe(SUN_OPTIONS)
  })

  it('a stored full_sun shows as Full sun, and every option is a word', () => {
    const { container } = renderEditor()
    openAllSections(container)
    const select = container.querySelector('#variety-edit-sun_requirements')
    expect(select.value).toBe('full_sun')
    expect(select.selectedOptions[0].textContent).toBe('Full sun')
    const words = [...select.options].filter(o => o.value).map(o => o.textContent)
    expect(words).toEqual(['Full sun', 'Part sun', 'Part shade', 'Full shade'])
  })
})

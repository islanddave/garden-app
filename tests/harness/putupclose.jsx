// V5-KBCLOSE-001 / V5-BATCHCLOSE-001 — the kitchen-batch close-out at Dave's real geometry.
//
// THE GAP THIS FILLS. The close-out surfaces shipped to prod in v4.115.0 with their layout REASONED
// ABOUT and never measured: the close sheet, the closed-batch archive, and the batch detail that
// carries the door between them. jsdom returns 0 from every getBoundingClientRect (see
// tests/harness/README.md), so PutUpBatchClose.test.jsx / PutUpClosedBatches.test.jsx /
// PutUpBatchDetail.test.jsx are green about CONTENT and structurally cannot answer "does the
// 40-character outcome label clip beside its chip at 390px", "does the last Reopen button clear the
// fixed bottom nav", or "is Record it reachable with the keyboard up". 390px is the only viewport
// that matters — Dave uses this app exclusively on an Android phone in a PWA.
//
// THE REAL PAGE, not the components. `?state=closed` and `?batch=<id>` are mode flags on /put-up
// (PutUp.jsx:286-288), so mounting PutUp and setting the search param renders exactly the tree prod
// renders — the page's own container padding, its h1, its ← Going now exit, and the mode surface.
// Mounting ClosedBatchesView directly would measure a layout that has no page around it, which is
// the container whose bottom padding the band check below is really about.
//
// A REAL <nav aria-label="Main navigation"> IS MOUNTED, copying tests/harness/putupwalk.jsx and for
// the inverse reason. That entry mounts one because the walk SUPPRESSES it and the suppression has to
// be falsifiable; this one mounts it because /put-up in ordinary mode does NOT suppress it — App.jsx
// renders <BottomNav /> for every signed-in route — so 56px of fixed chrome sits over the bottom of
// this page in prod. Leave it out and the archive's last Reopen button is measured in mid-air.
//
// FIXTURE PROVENANCE, said out loud. The batch rows below are the repo's OWN shipped test fixtures
// (PutUpClosedBatches.test.jsx:82-134, PutUpBatchDetail.test.jsx:62-108) rather than invented ones,
// so the vocabulary, the column shapes and the string lengths are the ones the suite already agreed
// are real. ONE label is constructed — LONG_LABEL — and it is NOT a measured prod maximum: this lane
// has no database access, `label` is `text NOT NULL` with no length CHECK
// (migrations/v5-inflightbatch-001/0a-additive-ddl.sql:72) and the start form sets no maxLength, so a
// long label is reachable rather than hypothetical. It is built to the shape that DDL line documents
// as the intended one ("Pepper mash — Aug 2026"). Treat it as a worst case chosen honestly, not as a
// row anyone has seen.
//
// `output_count` and `input_count` ARE STRINGS. They are uncast bigint counts in
// v_kitchen_batch_current and JSON hands those back as strings — ClosedBatchesView.jsx:146 coerces
// with Number() precisely because of that boundary. A fixture holding numbers would be a row no real
// database can produce, which is the class of defect gate:seeds-saved caught on its own first run.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import PutUp from '../../src/pages/PutUp.jsx'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'

const q = new URLSearchParams(location.search)
const CASE = q.get('case') || 'closed'

const iso = (s) => new Date(s).toISOString()

// The one constructed string. 58 characters — a kind, a crop, a batch discriminator and the month,
// which is what a cook who runs more than one crock at a time actually types.
const LONG_LABEL = 'Ferment — Reaper & Bhut mash, third crock — Aug 2026'

// ── closed archive ───────────────────────────────────────────────────────────────────────────────
// NINE rows across FOUR month groups, and the fourth group is in a DIFFERENT CALENDAR YEAR on
// purpose: monthLabel() appends the year only outside the current one (ClosedBatchesView.jsx:100-105),
// so without a prior-year row the longest heading this surface can render — "November 2025" — would
// never be on screen and its width would never be measured. Ordering is deliberately NOT closed_at
// DESC here: sortClosed owns that, and handing it a pre-sorted list would measure a grouping the
// component did not have to compute.
//
// NINE AND NOT FIVE, and the reason is the band check rather than the content. At five rows the page
// measured 844px against an 844px viewport — it did not scroll, so scrolling it to the end was a
// no-op and the archive's last Reopen sat 50px above the nav for the trivial reason that the list
// stopped early. The surface has NO pagination, so a real archive is unbounded and the state worth
// measuring is the one where the list runs past the fold and the container's bottom padding is the
// only thing holding the last row off the bar. Nine rows put it there.
const CLOSED = [
  { id: 'kb-c-crock', user_id: 'user_dave', label: 'Crock of something', kind: 'ferment', kind_other: null,
    started_at: iso('2026-08-10T09:00:00'), start_precision: 'week', first_recorded_at: iso('2026-08-10T09:00:00'),
    expected_days_min: null, expected_days_max: null,
    suspended_at: null, closed_at: '2026-08-14T12:00:00.000Z', outcome: 'abandoned', outcome_note: null,
    current_stage_kind: 'tended', current_stage_label: 'Skimmed', current_stage_entered_at: iso('2026-08-12T09:00:00'),
    input_count: '0', output_count: '0' },
  // The long label AND the highest output count, together: 'put_up' is one of only two outcomes that
  // produce jars at all, so the widest title and the widest meta line share one row. That is the row
  // where the title column and the Reopen button are closest to colliding.
  { id: 'kb-c-reaper', user_id: 'user_dave', label: LONG_LABEL, kind: 'ferment', kind_other: null,
    started_at: iso('2026-07-28T09:00:00'), start_precision: 'day', first_recorded_at: iso('2026-07-28T09:00:00'),
    expected_days_min: 21, expected_days_max: 42,
    suspended_at: null, closed_at: '2026-09-02T12:00:00.000Z', outcome: 'put_up_different', outcome_note: 'Two quarts',
    current_stage_kind: 'finished', current_stage_label: null, current_stage_entered_at: '2026-09-02T12:00:00.000Z',
    input_count: '139', output_count: '12' },
  { id: 'kb-c-kraut', user_id: 'user_dave', label: 'Kraut, second crock', kind: 'ferment', kind_other: null,
    started_at: iso('2026-06-20T09:00:00'), start_precision: 'day', first_recorded_at: iso('2026-06-20T09:00:00'),
    expected_days_min: 21, expected_days_max: 42,
    suspended_at: null, closed_at: '2026-07-09T12:00:00.000Z', outcome: 'discarded_spoiled', outcome_note: null,
    current_stage_kind: 'failed', current_stage_label: null, current_stage_entered_at: '2026-07-09T12:00:00.000Z',
    input_count: '4', output_count: '0' },
  { id: 'kb-c-plum', user_id: 'user_jen', label: "Jen's plum butter", kind: 'preserve', kind_other: null,
    started_at: iso('2026-08-30T09:00:00'), start_precision: 'day', first_recorded_at: iso('2026-08-30T09:00:00'),
    expected_days_min: null, expected_days_max: null,
    suspended_at: null, closed_at: '2026-09-04T12:00:00.000Z', outcome: 'put_up', outcome_note: null,
    current_stage_kind: 'finished', current_stage_label: null, current_stage_entered_at: '2026-09-04T12:00:00.000Z',
    input_count: '1', output_count: '6' },
  // Prior year. Carries the "November 2025" heading and nothing else this fixture needs.
  { id: 'kb-c-cider', user_id: 'user_dave', label: 'Cider vinegar, first go', kind: 'ferment', kind_other: null,
    started_at: iso('2025-09-14T09:00:00'), start_precision: 'week', first_recorded_at: iso('2025-09-14T09:00:00'),
    expected_days_min: null, expected_days_max: null,
    suspended_at: null, closed_at: '2025-11-21T12:00:00.000Z', outcome: 'consumed', outcome_note: null,
    current_stage_kind: 'finished', current_stage_label: null, current_stage_entered_at: '2025-11-21T12:00:00.000Z',
    input_count: '2', output_count: '0' },
  // The four that make the list run past the fold. Short labels and ordinary outcomes on purpose:
  // the worst case for a ROW is already carried by kb-c-reaper above, and these exist to give the
  // page height, not a second hard case. They land in the three 2026 groups so the group COUNT does
  // not move — a fixture that quietly changed the number of headings would be changing what the
  // grouping assertion means while pretending to change only the length.
  { id: 'kb-c-relish', user_id: 'user_dave', label: 'Corn relish', kind: 'other', kind_other: 'water bath',
    started_at: iso('2026-08-29T09:00:00'), start_precision: 'day', first_recorded_at: iso('2026-08-29T09:00:00'),
    expected_days_min: null, expected_days_max: null,
    suspended_at: null, closed_at: '2026-09-01T12:00:00.000Z', outcome: 'put_up', outcome_note: null,
    current_stage_kind: 'finished', current_stage_label: null, current_stage_entered_at: '2026-09-01T12:00:00.000Z',
    input_count: '5', output_count: '7' },
  { id: 'kb-c-dilly', user_id: 'user_dave', label: 'Dilly beans', kind: 'ferment', kind_other: null,
    started_at: iso('2026-08-08T09:00:00'), start_precision: 'day', first_recorded_at: iso('2026-08-08T09:00:00'),
    expected_days_min: 7, expected_days_max: 14,
    suspended_at: null, closed_at: '2026-08-22T12:00:00.000Z', outcome: 'put_up', outcome_note: null,
    current_stage_kind: 'finished', current_stage_label: null, current_stage_entered_at: '2026-08-22T12:00:00.000Z',
    input_count: '3', output_count: '4' },
  { id: 'kb-c-hotsauce', user_id: 'user_dave', label: 'Hot sauce, small pot', kind: 'ferment', kind_other: null,
    started_at: iso('2026-07-18T09:00:00'), start_precision: 'day', first_recorded_at: iso('2026-07-18T09:00:00'),
    expected_days_min: null, expected_days_max: null,
    suspended_at: null, closed_at: '2026-08-05T12:00:00.000Z', outcome: 'given_away', outcome_note: null,
    current_stage_kind: 'finished', current_stage_label: null, current_stage_entered_at: '2026-08-05T12:00:00.000Z',
    input_count: '2', output_count: '1' },
  { id: 'kb-c-shrub', user_id: 'user_jen', label: 'Blackberry shrub', kind: 'infuse', kind_other: null,
    started_at: iso('2026-07-02T09:00:00'), start_precision: 'week', first_recorded_at: iso('2026-07-02T09:00:00'),
    expected_days_min: null, expected_days_max: null,
    suspended_at: null, closed_at: '2026-07-25T12:00:00.000Z', outcome: 'consumed', outcome_note: null,
    current_stage_kind: 'finished', current_stage_label: null, current_stage_entered_at: '2026-07-25T12:00:00.000Z',
    input_count: '2', output_count: '0' },
]

// ── the open batch the close sheet is opened FROM ────────────────────────────────────────────────
// closed_at MUST be null: BatchCloseField returns null for a closed batch (BatchCloseField.jsx:142),
// so a fixture that closed this row would render no door and every sheet case below would measure an
// empty page while reporting a pass. The gate asserts the door's presence for that reason.
// `kind: 'ferment'` picks the cue placeholder ("bubbling stopped") — the placeholder is what the cue
// input renders before anything is typed, so it is the string whose width is actually on screen.
const DETAIL = {
  id: 'kb-mash', user_id: 'user_dave', label: LONG_LABEL, kind: 'ferment', kind_other: null,
  started_at: iso('2026-08-02T09:00:00'), start_precision: 'day', first_recorded_at: iso('2026-08-02T09:00:00'),
  expected_days_min: 21, expected_days_max: 42,
  suspended_at: null, closed_at: null, outcome: null, outcome_note: null,
  current_stage_kind: 'tended', current_stage_label: 'Skimmed the kahm yeast off the top',
  current_stage_entered_at: iso('2026-09-01T09:00:00'),
  input_count: '3', output_count: '0',
  inputs: [
    { id: 'kbi-1', batch_id: 'kb-mash', input_kind: 'harvest', harvest_log_id: 'hl-1', label: null,
      qty: null, qty_unit: null, is_byproduct: false, added_at: iso('2026-08-02T09:00:00'),
      crop_label: 'Carolina Reaper', harvest_qty: '4.2', harvest_qty_unit: 'lb' },
    { id: 'kbi-2', batch_id: 'kb-mash', input_kind: 'pantry', harvest_log_id: null, label: 'Kosher salt',
      qty: '40', qty_unit: 'g', is_byproduct: false, added_at: iso('2026-08-02T09:00:00') },
    { id: 'kbi-3', batch_id: 'kb-mash', input_kind: 'pantry', harvest_log_id: null,
      label: 'Filtered well water, brought to room temperature', qty: '1.5', qty_unit: 'l',
      is_byproduct: false, added_at: iso('2026-08-02T09:00:00') },
  ],
  stages: [
    { id: 'ksl-1', batch_id: 'kb-mash', stage_kind: 'started', label: null, entered_at: iso('2026-08-02T09:00:00'),
      cue_observed: null, note: null },
    { id: 'ksl-2', batch_id: 'kb-mash', stage_kind: 'tended', label: 'Skimmed the kahm yeast off the top',
      entered_at: iso('2026-09-01T09:00:00'), cue_observed: 'white film across the whole surface',
      note: 'Smelled clean underneath, put the weight back on' },
  ],
  outputs: [],
}

// ── the jar list inside the close sheet ──────────────────────────────────────────────────────────
// whats-put-up answers `{ group_by, groups: [{ label, records }] }` and the GROUP LABEL is the only
// place the crop name appears (JarPicker.jsx:52-55), so the grouping is not cosmetic — flatten it
// away and every row loses its identity string.
//
// FOUR rows, TWO of them deliberately BLOCKED. Ineligible jars render disabled with the reason inline
// rather than being omitted (JarPicker.jsx:12-16), so a fixture of only linkable rows would never
// render `jar-picker-reason` — a second line inside a row whose button already carries a 44px floor,
// and therefore the row most likely to grow past what the picker's box allows.
const JARS = {
  group_by: 'crop',
  groups: [
    { label: 'Carolina Reaper', records: [
      { id: 'pl-1', quantity_value: '2', quantity_unit: 'pint', preserved_at: '2026-09-02',
        harvest_log_id: null, batch_id: null },
      { id: 'pl-2', quantity_value: '0.5', quantity_unit: 'pint', preserved_at: '2026-09-02',
        harvest_log_id: null, batch_id: null },
      { id: 'pl-3', quantity_value: '1', quantity_unit: 'quart', preserved_at: '2026-08-30',
        harvest_log_id: 'hl-9', batch_id: null },
    ] },
    { label: 'Bhut Jolokia', records: [
      { id: 'pl-4', quantity_value: '3', quantity_unit: 'half-pint', preserved_at: '2026-08-19',
        harvest_log_id: null, batch_id: 'kb-c-kraut' },
    ] },
  ],
}

// Stub at the network layer so the REAL page, the REAL useApiFetch, the REAL Sheet and the REAL
// JarPicker all run and only the far side of the wire is faked — aliasing src/lib/api.js would test
// the harness instead. ORDER MATTERS: '/api/kitchen-batches?state=' must be matched before the bare
// '/api/kitchen-batches/' detail path, and the close POST before either.
const realFetch = window.fetch
const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
window.fetch = (url, ...rest) => {
  const u = String(url)
  if (u.includes('/close')) return json({ ok: true })
  if (u.includes('/api/kitchen-batches?state=closed')) return json({ state: 'closed', batches: CASE === 'closed-empty' ? [] : CLOSED })
  if (u.includes('/api/kitchen-batches?state=going')) return json({ state: 'going', batches: [] })
  if (u.includes('/api/kitchen-batches/')) return json(DETAIL)
  if (u.includes('/api/preservation/whats-put-up')) return json(JARS)
  // BatchInputsField's add flow self-fetches this. Left to fall through it 404s against the harness
  // server and the section renders its load-failure copy, which would read as a layout finding.
  if (u.includes('/api/harvests')) return json({ aggregates: { crops: [] }, harvests: [] })
  return realFetch(url, ...rest)
}

const settle = () => new Promise((r) => setTimeout(r, 160))
const byTid = (t) => document.querySelector(`[data-testid="${t}"]`)

// The mode flag each case needs. `batch` wins over `state` at the page (PutUp.jsx:286), so the two
// are never both set.
const ENTRY = CASE.startsWith('closed') ? '/put-up?state=closed' : `/put-up?batch=${DETAIL.id}`

async function run() {
  createRoot(document.getElementById('root')).render(
    <MemoryRouter initialEntries={[ENTRY]}>
      <PutUp />
      {/* The real element, not a stand-in div: App.jsx renders <BottomNav /> at 56px fixed for every
          signed-in route and the archive's last row sits under it or clears it. A stand-in with a
          different tag would leave the same 56px of chrome unmeasurable by selector. */}
      <nav aria-label="Main navigation"
        style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: BOTTOM_NAV_HEIGHT_PX,
          zIndex: 100, background: '#fff', borderTop: '1px solid #d4c9be', display: 'flex',
          alignItems: 'center', justifyContent: 'center', font: '10px ui-monospace, monospace',
          color: '#8a8a8a' }}>
        real BottomNav element ({BOTTOM_NAV_HEIGHT_PX}px)
      </nav>
    </MemoryRouter>,
  )
  await settle(); await settle()

  // Open the sheet by TAPPING the real controls rather than by forcing state — the question these
  // cases exist to answer is whether the close-out is REACHABLE and fits, and a forced mount answers
  // neither. Each step is a separate tap because each step is a separate surface.
  if (CASE.startsWith('close-')) {
    byTid('batch-close-open')?.click()
    await settle()
  }
  if (CASE === 'close-yes') { byTid('batch-close-kept-yes')?.click(); await settle(); await settle() }
  if (CASE === 'close-no') { byTid('batch-close-kept-no')?.click(); await settle(); await settle() }

  window.__h = { ready: () => true, all: measure }
  paint()
}

// Every number is read from the live document. This is the human-facing bar only; the assertions
// live in scripts/layout-gate/putup-close-clearance.mjs, which reads the same DOM through CDP.
function measure() {
  const de = document.documentElement
  const rows = [...document.querySelectorAll('[data-testid="closed-batch"]')]
  const controls = [...document.querySelectorAll('button, input, select, textarea')]
    .filter((el) => el.getClientRects().length)
  const short = controls
    .map((el) => ({ t: (el.getAttribute('data-testid') || el.textContent || el.type || '?').trim().slice(0, 26),
                    h: Math.round(el.getBoundingClientRect().height) }))
    .filter((x) => x.h > 0 && x.h < 44)
  return {
    case: CASE,
    vw: window.innerWidth,
    hscroll: de.scrollWidth > de.clientWidth,
    scrollW: de.scrollWidth,
    clientW: de.clientWidth,
    pageH: Math.round(de.scrollHeight),
    closedRows: rows.length,
    monthHeadings: document.querySelectorAll('[data-testid="closed-month-heading"]').length,
    closedEmpty: !!byTid('closed-empty'),
    detail: !!byTid('batch-detail-view'),
    closeDoor: !!byTid('batch-close-open'),
    sheetOpen: !!document.querySelector('[role="dialog"]'),
    outcomeChips: document.querySelectorAll('[data-testid^="batch-close-outcome-"]').length,
    jarRows: document.querySelectorAll('[data-testid="jar-picker-row"]').length,
    // Per-row horizontal overflow: the 51-char label beside a 96px-wide Reopen button is the reason
    // this entry exists.
    rowOverflow: rows.filter((r) => r.scrollWidth > r.clientWidth + 1).length,
    titleClipped: rows.filter((r) => {
      const col = r.firstElementChild
      return col && col.scrollWidth > col.clientWidth + 1
    }).length,
    under44: short,
  }
}

function paint() {
  const m = measure()
  // `verdict=0` strips the bar for a capture of the surface alone — it is z-index 99999 fixed and
  // would sit on top of the page's own h1, which is exactly what elementFromPoint would then report.
  if (q.get('verdict') === '0') {
    document.getElementById('verdict').remove()
    document.getElementById('root').style.paddingTop = '0px'
    return
  }
  const fails = []
  if (m.hscroll) fails.push('HORIZONTAL SCROLL')
  if (m.rowOverflow) fails.push(`${m.rowOverflow} closed row(s) overflow`)
  if (m.titleClipped) fails.push(`${m.titleClipped} title column(s) clipped`)
  if (m.under44.length) fails.push(`${m.under44.length} tap target(s) <44px: ` + m.under44.map((x) => `${x.t}=${x.h}`).join(', '))
  const el = document.getElementById('verdict')
  el.textContent = [
    `case=${m.case}  vw=${m.vw}px  scrollW=${m.scrollW}  hscroll=${m.hscroll ? 'YES' : 'no'}  pageH=${m.pageH}`,
    `closed=${m.closedRows}/${m.monthHeadings} empty=${m.closedEmpty} detail=${m.detail} door=${m.closeDoor} sheet=${m.sheetOpen} outcomes=${m.outcomeChips} jars=${m.jarRows}`,
    fails.length ? 'FAIL: ' + fails.join(' | ') : 'PASS — no overflow, no clipped title, all tap targets >=44px',
  ].join('\n')
  el.style.background = fails.length ? '#b94a3a' : '#4a7c59'
}

run()

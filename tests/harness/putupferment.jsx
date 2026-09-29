// Put-Up release F — THE FERMENT WALKS (06 §5 row L3 "3b": "Petri Dish, Settlers, kraut, kimchi, and
// Appendix C end to end from Start to Put it up and finish, then edit Made g and a line after finish").
//
// One walk per page load: ?walk=petri|settlers|kraut|kimchi|appendixc. The REAL PutUp page mounts under
// the Clerk stub, the REAL sheets open, and every tap is a click on the control a cook would tap —
// Start a batch, the line search, the Salt block, Jar & heat, Check on it, Put it up, the edit sheets.
// The far side of the wire is tests/harness/fermentFake.js: stateful, and judging every body with the
// Lambda's own validators and planners, so "the walk got through" also means "the Lambda would have
// taken every write". Run by scripts/layout-gate/putup-ferment-walk.mjs at 426×836 and 426×492 (the
// keyboard-up height, V4 §6.7).
//
// WHAT A WALK CHECKS, besides getting through:
//   · every tap lands on its control (the centre hit-tests to it; nothing painted over it) and every
//     field that takes focus sits inside the viewport and clear of a pinned footer or bar;
//   · at named checkpoints: no sideways scroll, every visible control ≥ T.tapMinHeight, and an open
//     sheet's primary action on screen at its first AND last scroll position;
//   · with the salt % focused: the %, the live line and "I put in" all on screen together;
//   · with Jar & heat's About focused: the field and its Save on screen;
//   · the golden values (06 §5.3) in the DOM and in what was written.
// `window.__walk.run()` resolves { walk, vw, vh, failures, notes, taps, typed, checks, writes }.
// `?probe=1` points every selector at a testid nothing renders: the walk MUST fail (the gate's
// --probe-nothing arm).
//
// FIRST IMPORT, on purpose: the Roboto pin (robotoPin.js) — the face Dave's Android lays these screens
// out in, and the same on every machine, so "fits at 426×492" means the same thing here and on CI.
import './robotoPin.js'
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/context/AuthContext.jsx'
import PutUp from '../../src/pages/PutUp.jsx'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'
import { T } from '../../src/components/forms/formStyles.js'
import { installFake, state, PLANTINGS, JARS, PLACES } from './fermentFake.js'

const q = new URLSearchParams(location.search)
const WALK = q.get('walk') ?? 'petri'
const PROBE = q.get('probe') === '1'
const TRACE = q.get('trace') === '1'     // each typed field's top, before → scrolled → focused → settled

installFake()

// ── the driver ────────────────────────────────────────────────────────────────────────────────────────
const failures = []
const notes = []
const counts = { taps: 0, typed: 0, checks: 0 }
const fail = (m) => { failures.push(m) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const frame = () => new Promise(r => requestAnimationFrame(() => r()))
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

// The network AND React: quiet twice in a row, then two frames.
async function settle() {
  let quiet = 0
  for (let i = 0; i < 400 && quiet < 2; i++) {
    await sleep(15)
    quiet = state.inflight === 0 ? quiet + 1 : 0
  }
  await frame(); await frame()
}

const sel = (tid) => `[data-testid="${PROBE ? '__probe_nothing__' : tid}"]`
const shown = (el) => !!el && (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true })) && el.getBoundingClientRect().height > 0
const describe = (el) => el.getAttribute?.('data-testid') || el.getAttribute?.('aria-label')
  || norm(el.textContent).slice(0, 40) || `<${String(el.tagName).toLowerCase()}>`
const rootOf = (within) => (typeof within === 'string' ? document.querySelector(within) : within) ?? document

async function find(tid, { within = document, ms = 5000 } = {}) {
  const t0 = performance.now()
  for (;;) {
    const list = [...rootOf(within).querySelectorAll(sel(tid))].filter(shown)
    if (list.length) return list[list.length - 1]
    if (performance.now() - t0 > ms) throw new Error(`nothing shown for ${tid}`)
    await sleep(25)
  }
}
async function findText(text, { within = document, ms = 5000 } = {}) {
  const t0 = performance.now()
  for (;;) {
    const hit = [...rootOf(within).querySelectorAll('button, [role="radio"], [role="tab"]')]
      .filter(shown).find(b => norm(b.textContent) === text && !PROBE)
    if (hit) return hit
    if (performance.now() - t0 > ms) throw new Error(`no control reading "${text}"`)
    await sleep(25)
  }
}
async function waitFor(fn, what, ms = 5000) {
  const t0 = performance.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

// Is anything painted over the element's centre? Bounds are exclusive at the far edge, and a null hit
// is "nothing to probe", never occlusion (the putup-close-clearance lessons).
function coveredBy(el) {
  const r = el.getBoundingClientRect()
  const x = (r.left + r.right) / 2
  const y = (r.top + r.bottom) / 2
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return `has its centre off screen (${Math.round(x)},${Math.round(y)} in ${innerWidth}×${innerHeight})`
  const at = document.elementFromPoint(x, y)
  if (!at || at === el || el.contains(at) || at.contains(el)) return null
  const a = at.getBoundingClientRect()
  return `is under "${describe(at)}" (it y${Math.round(r.top)}-${Math.round(r.bottom)}, that y${Math.round(a.top)}-${Math.round(a.bottom)})`
}
// The pinned things a field can end up beneath: the open sheet's sticky footer(s), the page's pinned
// Add bar, and the fixed nav while it shows.
function bandsFor(el) {
  const out = []
  const dlg = el.closest('[role="dialog"]')
  if (dlg) {
    for (const c of dlg.children) if (getComputedStyle(c).position === 'sticky' && !c.contains(el)) out.push(c)
  } else {
    for (const b of document.querySelectorAll('[data-pinned="true"]')) if (!b.contains(el) && shown(b)) out.push(b)
    const nav = document.querySelector('nav[aria-label="Main navigation"]')
    if (nav && shown(nav)) out.push(nav)
  }
  return out
}
function clearOfBands(el, what) {
  const r = el.getBoundingClientRect()
  if (r.top < -0.5 || r.bottom > innerHeight + 0.5) { fail(`${what}: ${Math.round(r.top)}..${Math.round(r.bottom)} is outside the ${innerHeight}px viewport`); return }
  for (const band of bandsFor(el)) {
    const b = band.getBoundingClientRect()
    if (r.bottom > b.top + 0.5 && r.top < b.bottom - 0.5) {
      fail(`${what}: under "${describe(band)}" (field ${Math.round(r.top)}..${Math.round(r.bottom)}, band ${Math.round(b.top)}..${Math.round(b.bottom)})`)
    }
  }
}

async function press(el, what) {
  if (el.disabled) fail(`${what}: tapped while disabled`)
  el.scrollIntoView({ block: 'center', inline: 'nearest' })
  await frame()
  const why = coveredBy(el)
  if (why) fail(`tap ${what}: ${why}`)
  const d = TRACE ? topDialog() : null
  const s0 = d?.scrollTop
  el.click()
  counts.taps += 1
  await settle()
  if (TRACE && d) notes.push(`tap ${what}: sheet scrollTop ${Math.round(s0)} → ${Math.round(d.scrollTop)} (of ${d.scrollHeight - d.clientHeight})`)
}
const tap = async (tid, opts) => press(await find(tid, opts), tid)
const tapText = async (text, opts) => press(await findText(text, opts), `"${text}"`)

function setValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
}
// Focus as a tap does (the browser scrolls it in; the sheets' keep-clear handlers run), check where
// it landed, then type.
async function type(tid, value, opts = {}) {
  const el = await find(tid, opts)
  const y = () => Math.round(el.getBoundingClientRect().top)
  const trace = [y()]
  el.scrollIntoView({ block: 'nearest' })
  trace.push(y())
  el.focus()
  trace.push(y())
  await frame(); await frame(); await sleep(30)
  trace.push(y())
  if (TRACE) notes.push(`type ${tid}: top ${trace.join(' → ')}`)
  if (document.activeElement !== el) fail(`${tid}: did not take focus`)
  clearOfBands(el, `focused ${tid}`)
  const why = coveredBy(el)
  if (why) fail(`focused ${tid}: ${why}`)
  setValue(el, value)
  counts.typed += 1
  await settle()
  return el
}
async function choose(tid, value, opts) {
  const el = await find(tid, opts)
  setValue(el, value)
  await settle()
}
const blur = async () => { document.activeElement?.blur?.(); await settle() }

// ── checkpoints ──────────────────────────────────────────────────────────────────────────────────────
const topDialog = () => [...document.querySelectorAll('[role="dialog"]')].filter(shown).pop() ?? null
function census(root, where) {
  const controls = [...root.querySelectorAll('button, input:not([type="hidden"]):not([type="file"]), select, textarea, [role="button"]')].filter(shown)
  // A button is a target in both directions (min of width and height, as putup-close-clearance.mjs
  // measures sheets); a text field is as wide as its layout makes it, so only its height is a floor.
  for (const c of controls) {
    const r = c.getBoundingClientRect()
    const field = c.tagName === 'INPUT' || c.tagName === 'TEXTAREA' || c.tagName === 'SELECT'
    const size = field ? r.height : Math.min(r.width, r.height)
    if (size + 0.5 < T.tapMinHeight) fail(`${where}: "${describe(c)}" is ${r.width.toFixed(0)}×${r.height.toFixed(1)}px (floor ${T.tapMinHeight})`)
  }
  counts.checks += 1
  if (!controls.length) fail(`${where}: no controls to measure — the checkpoint measured nothing`)
  return controls.length
}
function noSideways(where) {
  const de = document.documentElement
  if (de.scrollWidth > innerWidth + 1) fail(`${where}: the page scrolls sideways (${de.scrollWidth} > ${innerWidth})`)
  for (const d of document.querySelectorAll('[role="dialog"]')) {
    if (d.scrollWidth > d.clientWidth + 1) fail(`${where}: the sheet "${d.getAttribute('aria-label')}" scrolls sideways (${d.scrollWidth} > ${d.clientWidth})`)
  }
}
async function checkPage(where) {
  await settle()
  noSideways(where)
  const view = await find('batch-detail-view')
  census(view, where)
}
// An open sheet: nothing sideways, the census, and its primary action on screen and hit-testing to
// itself at the first and the last scroll position.
async function checkSheet(primaryTid, where) {
  await settle()
  const d = topDialog()
  if (!d) { fail(`${where}: no sheet open`); return }
  noSideways(where)
  census(d, where)
  const before = d.scrollTop
  for (const pos of ['top', 'end']) {
    d.scrollTop = pos === 'top' ? 0 : d.scrollHeight
    await frame(); await frame()
    const b = [...d.querySelectorAll(sel(primaryTid))].filter(shown).pop()
    if (!b) { fail(`${where} (${pos}): ${primaryTid} is not on the sheet`); continue }
    const r = b.getBoundingClientRect()
    if (r.top < -0.5 || r.bottom > innerHeight + 0.5) fail(`${where} (${pos}): ${primaryTid} is off screen (${Math.round(r.top)}..${Math.round(r.bottom)} of ${innerHeight})`)
    const why = coveredBy(b)
    if (why) fail(`${where} (${pos}): ${primaryTid} ${why}`)
  }
  d.scrollTop = before
  await frame()
}
// Several things that must be on screen TOGETHER (the salt payoff; About and its Save).
function together(where, tids) {
  counts.checks += 1
  for (const tid of tids) {
    const el = [...document.querySelectorAll(sel(tid))].filter(shown).pop()
    if (!el) { fail(`${where}: ${tid} is not shown`); continue }
    clearOfBands(el, `${where}: ${tid}`)
    const why = coveredBy(el)
    if (why) fail(`${where}: ${tid} ${why}`)
  }
}

// ── assertions ───────────────────────────────────────────────────────────────────────────────────────
function expect(cond, msg) { counts.checks += 1; if (!cond) fail(msg) }
async function expectText(tid, want, { within = document, ms = 4000 } = {}) {
  const t0 = performance.now()
  let last = null
  for (;;) {
    const el = [...rootOf(within).querySelectorAll(sel(tid))].filter(shown).pop()
    last = el ? norm(el.textContent) : null
    const okNow = last != null && (want instanceof RegExp ? want.test(last) : last.includes(want))
    if (okNow) { counts.checks += 1; return last }
    if (performance.now() - t0 > ms) { counts.checks += 1; fail(`${tid}: wanted ${want} — read ${JSON.stringify(last)}`); return last }
    await sleep(30)
  }
}
const valueOf = async (tid, opts) => (await find(tid, opts)).value

// The one batch a walk works on, and its live lines, straight from the stand-in's store.
const theBatch = () => state.batches[state.batches.length - 1]
const liveLines = () => state.lines.filter(l => l.batch_id === theBatch()?.id && l.deleted_at == null)
const lineNamed = (label) => liveLines().find(l => l.label === label)
const saltRows = () => liveLines().filter(l => l.role === 'salt')
const sittingStage = () => state.stages.filter(s => s.batch_id === theBatch()?.id && s.stage_kind === 'put_up').pop()
const jarsOfBatch = () => JARS.filter(j => j.batch_id === theBatch()?.id)
const planting = (label) => PLANTINGS.find(p => p.label === label)
const jarLabelled = (label) => JARS.find(j => j.label === label)

// ── the steps a walk is made of ──────────────────────────────────────────────────────────────────────
async function startBatch(label) {
  await tapText('Going now', { within: '[aria-label="Put-Up view"]' })
  await tap('start-a-batch')
  await find('start-sheet')
  await checkSheet('start-submit', 'Start sheet')
  await type('start-label', label)
  await tap('start-kind-toggle')
  await tap('start-kind-ferment')
  await tap('start-submit')
  await find('batch-detail-view')
  await expectText('batch-detail-title', label)
  expect(theBatch()?.kind === 'ferment', `the batch was started as ${theBatch()?.kind}, not ferment`)
}

async function setUnit(prefix, unit) {
  const chip = await find(`${prefix}-unit-${unit}`)
  if (chip.getAttribute('aria-checked') !== 'true') await press(chip, `${prefix}-unit-${unit}`)
}
async function more(prefix, { form, rating, note, brand }) {
  if (form == null && rating == null && note == null && brand == null) return
  await tap(`${prefix}-more`)
  if (form) await tap(`${prefix}-form-${form}`)
  if (rating != null) await type(`${prefix}-heat`, rating)
  if (brand != null) await type(`${prefix}-brand`, brand)
  if (note != null) await type(`${prefix}-note`, note)
}
// One line through the adder: a search hit (planting or jar), or a typed name. Resolves once the
// write landed (the adder's host re-read shows it, or the sheet row appeared).
async function addLine(prefix, { search, hit, typed, pickId, count, qty, unit, form, rating, note, brand, expectLeft, submit = 'submit' }) {
  const before = state.calls.length
  await type(`${prefix}-name`, search ?? typed)
  await find(`${prefix}-hits`)
  if (hit) await tap(`${prefix}-hit-${hit}`)
  else await tap(`${prefix}-typed`)
  if (pickId) await tap(`${prefix}-pick-${pickId}`)
  for (let i = 1; i < (count ?? 1); i++) await tap(`${prefix}-count-plus`)
  if (qty != null) await type(`${prefix}-qty`, String(qty))
  if (unit) await setUnit(prefix, unit)
  if (expectLeft) await expectText(`${prefix}-left-after`, expectLeft)
  await more(prefix, { form, rating, note, brand })
  await tap(`${prefix}-${submit}`)
  return state.calls.slice(before)
}
async function addBatchLine(spec) {
  const n = liveLines().length
  await addLine('line-add', spec)
  await waitFor(() => liveLines().length === n + 1, `line ${spec.search ?? spec.typed} to be written`)
  await settle()
  return liveLines()[liveLines().length - 1]
}
async function addWater(qty, unit) {
  const n = liveLines().length
  await tap('what-went-in-water')
  await type('line-add-qty', String(qty))
  await setUnit('line-add', unit)
  await tap('line-add-submit')
  await waitFor(() => liveLines().length === n + 1, 'the water line to be written')
  await settle()
}

// A salt step. Opened through the [Salt] chip (which focuses the %), unless `another`.
async function saltStep({ another = false, method, soak, pct, base, typeGrams, expectLive, expectGrams, expectAside, expectCard }) {
  const n = saltRows().length
  if (another) await tap('salt-another')
  else { await tap('what-went-in-salt'); await sleep(60) }
  if (method) await tap(`salt-step-0-method-${method}`)
  if (soak != null) await type('salt-step-0-soak', String(soak))
  await type('salt-step-0-pct', String(pct))
  if (base) await tap(`salt-step-0-base-${base}`)
  // The payoff, with the % focused: the %, the live line and "I put in" on screen together.
  const pctEl = await find('salt-step-0-pct')
  pctEl.focus(); await frame(); await frame(); await sleep(30)
  together('salt % focused', ['salt-step-0-pct', 'salt-step-0-live', 'salt-step-0-write'])
  if (expectLive) await expectText('salt-step-0-live-words', expectLive)
  if (expectGrams) expect((await valueOf('salt-step-0-live-grams')) === expectGrams, `the live grams read ${await valueOf('salt-step-0-live-grams')}, not ${expectGrams}`)
  if (expectAside) await expectText('salt-step-0-aside', expectAside)
  if (typeGrams != null) await type('salt-step-0-live-grams', String(typeGrams))
  await tap('salt-step-0-write')
  await waitFor(() => saltRows().length === n + 1, 'the salt line to be written')
  await settle()
  const row = saltRows()[saltRows().length - 1]
  if (expectCard) await expectText(`salt-line-${row.id}`, expectCard)
  return row
}

async function openJarHeat() {
  const s = await find('jar-heat-summary')
  if (s.getAttribute('aria-expanded') !== 'true') await press(s, 'jar-heat-summary')
  await find('jar-heat-panel')
}
async function aboutCheckpoint(value, unit, save) {
  await openJarHeat()
  await type('jar-about', value)
  together('About focused', ['jar-about', 'jar-about-save'])
  if (unit) await tap(`jar-about-unit-${unit}`)
  if (save) await tap('jar-about-save')
  else await blur()
}
async function closeSheet() {
  const d = topDialog()
  const x = d?.querySelector('[data-sheet-close="true"]')
  if (!x) { fail('no sheet to close'); return }
  await press(x, 'the sheet close')
  await waitFor(() => !topDialog(), 'the sheet to close')
}
// Work it out → the figure (saved) or the refusal (closed).
async function workItOut(openTid, { within, figure, refusal, over, save = true }) {
  await tap(openTid, { within })
  await find('shu-sheet')
  if (figure) {
    await expectText('shu-figure', figure)
    if (over) await expectText('shu-sheet', over)
    await checkSheet('shu-save', `heat sheet (${openTid})`)
    if (save) { await tap('shu-save'); await waitFor(() => !topDialog(), 'the heat sheet to close') } else await closeSheet()
  } else {
    await expectText('shu-refusal', refusal)
    expect(!document.querySelector(sel('shu-figure')), 'a refusal must show no figure (never 0)')
    await closeSheet()
  }
  await settle()
}

async function checkOnIt({ acts = [], topUp, note }) {
  const n = state.stages.length
  await tap('batch-detail-check')
  await find('checkin-sheet')
  for (const a of acts) await tap(`checkin-act-${a}`)
  if (topUp) { await type('checkin-topup-amount', String(topUp.qty)); if (topUp.unit) await choose('checkin-topup-unit', topUp.unit) }
  if (note) await type('checkin-note', note)
  await checkSheet('checkin-save', 'Check on it')
  await tap('checkin-save')
  await waitFor(() => state.stages.length > n, 'the check-in to be written')
  await settle()
  return state.stages.filter(s => s.stage_kind === 'tended').pop()
}

// Put it up: rows [{ method-agnostic: count, container, place, name, ph, added: [...], discardDay }], the
// sitting's lines, Made, Mash in, Next time; then finish.
async function putItUp({ method, rows, sittingLines = [], made, mash, nextTime }) {
  await tap('batch-detail-put-up')
  await find('putup-sheet')
  await tap('putup-when-today')
  await tap(`putup-method-${method}`)
  for (const [i, r] of rows.entries()) {
    if (i > 0) await tap('putup-row-add')
    for (let c = 1; c < (r.count ?? 1); c++) await tap(`putup-row-${i}-plus`)
    if (r.container) await tap(`putup-row-${i}-container-${r.container}`)
    if (r.place) await tap(`putup-row-${i}-place-id:${PLACES.find(p => p.label === r.place).id}`)
    if (r.name || r.ph || r.added?.length || r.discardDay) {
      await tap(`putup-row-${i}-more`)
      if (r.name) await type(`putup-row-${i}-name`, r.name)
      for (const a of r.added ?? []) {
        await tap(`putup-row-${i}-added-open`)
        await addLine(`putup-row-${i}-added-add`, a)
        await find(`putup-row-${i}-added-open`)
      }
      if (r.ph) await type(`putup-row-${i}-ph-input`, r.ph)
      if (r.discardDay) {
        await tap(`putup-row-${i}-discard-date`)
        await type(`putup-row-${i}-discard-day`, r.discardDay)
      }
      await tap(`putup-row-${i}-more`)
    }
  }
  if (sittingLines.length || made || mash || nextTime) {
    await tap('putup-sitting-more')
    for (const a of sittingLines) {
      await tap('putup-sitting-added-open')
      await addLine('putup-sitting-added-add', a)
      await find('putup-sitting-added-open')
    }
    if (made) await type('putup-made', String(made))
    if (mash) await type('putup-mash', String(mash))
    if (nextTime) await type('putup-nexttime', nextTime)
  }
  await checkSheet('putup-finish', 'Put it up')
  await tap('putup-finish')
  await waitFor(() => theBatch()?.closed_at, 'the put-up to finish the batch')
  await waitFor(() => !topDialog(), 'the Put it up sheet to close')
  await settle()
  await find('batch-detail-sitting')
  await expectText('batch-detail-outcome', /./)
  expect(!document.querySelector(sel('batch-detail-put-up')), 'a finished batch still offers Put it up')
}

// After finish: Made g through the sitting's own Log entry, then one line through its sheet.
async function editMade(to) {
  await tap('batch-detail-sitting-head')
  await find('stage-edit')
  await type('stage-edit-amount', String(to))
  await checkSheet('stage-edit-save', 'edit Made')
  await tap('stage-edit-save')
  await waitFor(() => Number(sittingStage()?.amount) === Number(to), `Made to read ${to}`)
  await settle()
  await expectText('batch-detail-sitting-facts', `made ${to} g in all`)
  await find('stage-saved')
  expect(sittingStage().edited_at != null, 'the sitting was not marked edited')
}
async function editLine(label, edit) {
  const line = lineNamed(label)
  if (!line) { fail(`no live line named ${label}`); return }
  await tap(`line-row-${line.id}`)
  await find('line-sheet')
  if (edit.note != null) await type('line-sheet-note', edit.note)
  if (edit.qty != null) await type('line-sheet-qty', String(edit.qty))
  if (edit.rating != null) await type('line-sheet-rating', edit.rating)
  await checkSheet('line-sheet-save', `edit ${label}`)
  await tap('line-sheet-save')
  await waitFor(() => lineNamed(label)?.edited_at, `${label} to be edited`)
  await settle()
  await find('line-saved')
  return lineNamed(label)
}
function gardenAmbient(names) {
  const el = document.querySelector(sel('what-went-in-garden'))
  const text = el ? norm(el.textContent) : ''
  expect(el != null, 'no "From the garden" line')
  for (const n of names) expect(text.includes(n), `"From the garden" does not name ${n}: ${JSON.stringify(text)}`)
  // Reward UX: ambient words only — no count, no sum, no badge.
  expect(!/\d/.test(text), `"From the garden" carries a number: ${JSON.stringify(text)}`)
}
function noRefusals(where) {
  for (const e of state.errors) fail(`${where}: the Lambda's validators refused ${e.method} ${e.path} (${e.status}): ${JSON.stringify(e.body)} — sent ${JSON.stringify(e.sent)}`)
  state.errors.length = 0
}

// ── the walks ────────────────────────────────────────────────────────────────────────────────────────
const P = (label) => `planting:${planting(label).plant_id}`
const J = (label) => `jar:${jarLabelled(label).id}`

const WALKS = {
  // hot-ones-2026/recipes-v3.md §4 — Petri Dish Pioneer: a brine ferment, vinegar finish.
  async petri() {
    await startBatch('Petri Dish Pioneer')
    await addBatchLine({ search: 'jala', hit: P('Jalapeño'), qty: 170, unit: 'g' })
    await addBatchLine({ typed: 'Garlic', qty: 8, unit: 'g' })
    await addBatchLine({ search: 'onio', hit: P('Onion, red'), qty: 20, unit: 'g' })
    await addWater(250, 'ml')
    await checkPage('Petri — lines in')
    gardenAmbient(['Jalapeño', 'Onion, red'])
    // 06 §5.3 "Petri forward" then "Petri card": 3.5% of Veg + water (448 g) → 15.7; edited to 13.5.
    const salt = await saltStep({ method: 'brine', pct: '3.5', expectLive: '(448 g)', expectGrams: '15.7', typeGrams: '13.5',
      expectCard: 'aimed 3.5% · put in 13.5 g = 3.0% of 448 g' })
    expect(salt.qty === '13.5' && salt.salt_pct === '3.5' && salt.salt_base === 'all' && salt.base_g === '448'
      && salt.salt_method === 'brine' && salt.base_from === 'lines', `Petri salt wrote ${JSON.stringify(salt)}`)
    await openJarHeat()
    await tap('jar-vessel-pint-jar')
    await aboutCheckpoint('450', null, false)
    await workItOut('jar-heat-work-it-out', { figure: 'est. 950–3.0k SHU' })
    await expectText('jar-heat-words', 'heat est. 950–3.0k SHU (worked out)')
    const check = await checkOnIt({ acts: ['pushed_under'], note: 'Brine clear, a few bubbles' })
    expect(JSON.stringify(check?.acts) === '["pushed_under"]', `the check-in wrote acts ${JSON.stringify(check?.acts)}`)
    await putItUp({
      method: 'hot_sauce',
      rows: [{ container: '8 oz woozy', place: 'Fridge', ph: '3.7' }],
      sittingLines: [{ typed: 'White vinegar', qty: 35, unit: 'g', submit: 'submit' },
        { typed: 'Reserved brine', qty: 22, unit: 'g' }, { typed: 'Xanthan', qty: '0.7', unit: 'g' }],
      made: 256, mash: 198,
    })
    const st = sittingStage()
    expect(st.amount === '256' && st.mash_in_g === '198', `Petri sitting wrote Made ${st.amount}, Mash in ${st.mash_in_g}`)
    const jar = jarsOfBatch()[0]
    expect(jar && jar.package_count === 1 && jar.quantity_value === '8' && jar.quantity_unit === 'fl oz', `Petri jar ${JSON.stringify(jar)}`)
    await workItOut('batch-detail-output-work-it-out', { within: `[data-jar-id="${jar.id}"]`, figure: 'est. 1.7–5.3k SHU', over: 'over 256 g made' })
    await expectText('batch-detail-output-heat', 'heat est. 1.7–5.3k SHU (worked out)', { within: `[data-jar-id="${jar.id}"]` })
    await editMade(250)
    const onion = await editLine('Onion, red', { note: 'Red onion, from the bed' })
    expect(onion?.note === 'Red onion, from the bed', `the onion note reads ${onion?.note}`)
    await checkPage('Petri — finished and edited')
    noRefusals('Petri')
  },

  // recipes-v3.md §7 — Settlers of Cayenne: a dry mash.
  async settlers() {
    await startBatch('Settlers of Cayenne')
    await addBatchLine({ search: 'rist', hit: P('Ristra Cayenne'), qty: 150, unit: 'g' })
    await addBatchLine({ typed: 'Sugar', qty: 2, unit: 'g' })
    // 06 §5.3 "Settlers salt": base 152 (sugar included), 3% → 4.56; the card's 4.5 g → 3.0%.
    const salt = await saltStep({ method: 'dry', pct: '3', expectLive: '(152 g)', expectGrams: '4.6', typeGrams: '4.5',
      expectCard: 'aimed 3% · put in 4.5 g = 3.0% of 152 g' })
    expect(salt.qty === '4.5' && salt.salt_base === 'produce' && salt.base_g === '152' && salt.salt_method === 'dry',
      `Settlers salt wrote ${JSON.stringify(salt)}`)
    await aboutCheckpoint('150', null, false)
    await putItUp({
      method: 'hot_sauce',
      rows: [{ container: '8 oz woozy', place: 'Fridge', ph: '3.6' }],
      sittingLines: [{ typed: 'White vinegar', qty: 72, unit: 'g' }, { typed: 'Xanthan', qty: '0.7', unit: 'g' }],
      made: 227, mash: 156,
    })
    const jar = jarsOfBatch()[0]
    // 06 §5.3 "Settlers SHU": 15,991 / 22,996 → "est. 16–23k SHU".
    await workItOut('batch-detail-output-work-it-out', { within: `[data-jar-id="${jar.id}"]`, figure: 'est. 16–23k SHU', over: 'over 227 g made' })
    expect(jar.shu_est_low === 15991 && jar.shu_est_high === 22996, `Settlers jar saved ${jar.shu_est_low}/${jar.shu_est_high}`)
    await editMade(230)
    const sugar = await editLine('Sugar', { note: 'Or 10 g live brine next time' })
    expect(sugar?.note === 'Or 10 g live brine next time', `the sugar note reads ${sugar?.note}`)
    await checkPage('Settlers — finished and edited')
    noRefusals('Settlers')
  },

  // A kraut: cabbage, 2% dry salt, no heat anywhere.
  async kraut() {
    await startBatch('Kraut')
    await addBatchLine({ typed: 'Green cabbage', qty: 1000, unit: 'g' })
    const salt = await saltStep({ method: 'dry', pct: '2', expectLive: '(1,000 g)', expectGrams: '20.0',
      expectCard: 'aimed 2% · put in 20.0 g = 2.0% of 1,000 g' })
    expect(salt.qty === '20' && salt.base_g === '1000', `kraut salt wrote ${JSON.stringify(salt)}`)
    await openJarHeat()
    await tap('jar-vessel-half-gallon-jar')
    await tap('jar-count-plus')
    await expectText('jar-heat-words', 'Half-gallon jar × 2')
    await aboutCheckpoint('2', 'qt', true)
    await expectText('jar-heat-words', 'about 2 qt')
    // Nothing with a listed heat: the refusal, never a 0.
    await workItOut('jar-heat-work-it-out', { refusal: 'Nothing with a listed heat — type it.' })
    await checkOnIt({ acts: ['skimmed'], note: 'Flat white film, skimmed' })
    await putItUp({ method: 'ferment', rows: [{ count: 2, container: 'quart', place: 'Fridge' }], made: 980 })
    const jar = jarsOfBatch()[0]
    expect(jar.package_count === 2 && jar.container_label === 'quart', `kraut jar ${JSON.stringify(jar)}`)
    await editMade(990)
    await editLine('Green cabbage', { note: 'Savoy next time' })
    await checkPage('Kraut — finished and edited')
    noRefusals('Kraut')
  },

  // A kimchi: a rinsed soak AND a paste salt (two salt steps), and gochugaru's heat.
  async kimchi() {
    await startBatch('Napa kimchi')
    await addBatchLine({ search: 'napa', hit: P('Napa cabbage'), qty: 1500, unit: 'g' })
    await addBatchLine({ typed: 'Korean radish', qty: 300, unit: 'g' })
    await addBatchLine({ typed: 'Gochugaru', qty: 40, unit: 'g', form: 'dried' })
    await addBatchLine({ typed: 'Garlic', qty: 20, unit: 'g' })
    await addBatchLine({ typed: 'Ginger', qty: 10, unit: 'g' })
    await addBatchLine({ typed: 'Fish sauce', qty: 30, unit: 'ml' })
    // 06 §5.3 "Kimchi": rinsed 10% of 2,000 g soak → 200 g, never the jar's; paste 1% of Veg only (1,870 g) → 18.7.
    const soak = await saltStep({ method: 'rinsed', soak: 2000, pct: '10', expectLive: '10% of 2,000 g soak water', expectGrams: '200.0',
      expectCard: "soaked, then rinsed off, so not what's in the jar" })
    expect(soak.qty === '200' && soak.salt_base === 'water' && soak.base_from === 'scale' && soak.base_g === '2000',
      `the soak salt wrote ${JSON.stringify(soak)}`)
    const paste = await saltStep({ another: true, method: 'dry', pct: '1', expectLive: '(1,870 g)', expectGrams: '18.7',
      expectAside: 'no weight: Fish sauce', expectCard: 'aimed 1% · put in 18.7 g = 1.0% of 1,870 g' })
    expect(paste.qty === '18.7' && paste.base_g === '1870', `the paste salt wrote ${JSON.stringify(paste)}`)
    await openJarHeat()
    await workItOut('jar-heat-work-it-out', { refusal: 'Gochugaru — no listed heat' })
    // The typed rating is the FRESH pepper's; the dried line counts ×7–10.
    const g = await editLine('Gochugaru', { rating: '4000–8000' })
    expect(g?.shu_rating_low === 4000 && g?.shu_rating_high === 8000, `the gochugaru rating wrote ${g?.shu_rating_low}–${g?.shu_rating_high}`)
    await openJarHeat()
    await workItOut('jar-heat-work-it-out', { figure: 'est. 600–1.7k SHU' })
    expect(theBatch().shu_est_low === 599 && theBatch().shu_est_high === 1711, `kimchi saved ${theBatch().shu_est_low}/${theBatch().shu_est_high}`)
    const check = await checkOnIt({ acts: ['topped_up'], topUp: { qty: 250, unit: 'ml' }, note: 'Pressed down, brine over the top' })
    expect(check?.amount === '250' && check?.amount_unit === 'ml', `the top-up wrote ${check?.amount} ${check?.amount_unit}`)
    await putItUp({ method: 'ferment', rows: [{ count: 2, container: 'quart', place: 'Fridge' }], made: 1900 })
    await editMade(1880)
    // A line edited after finishing moves the worked-out heat: flagged, never silently recomputed.
    await editLine('Gochugaru', { qty: 45 })
    await expectText('jar-heat-stale', 'worked out before later changes')
    await checkPage('Kimchi — finished and edited')
    noRefusals('Kimchi')
  },

  // 06 §5.3 "Appendix C (F-era)": plantings, a pick, a weighed draw, a counted draw, typed lines;
  // two rows, one with its own additions; Next time.
  async appendixc() {
    await startBatch('Appendix C')
    await addBatchLine({ search: 'mega', hit: P('Megatron jalapeño'), qty: 412, unit: 'g' })
    const serrano = planting('Serranos')
    await addBatchLine({ search: 'serr', hit: P('Serranos'), pickId: serrano.picks[0].harvest_log_id, qty: 230, unit: 'g' })
    await addBatchLine({ search: 'reap', hit: J('Reaper, frozen'), qty: 8, unit: 'g', expectLeft: 'about 92 g left after' })
    await addBatchLine({ search: 'carr', hit: J('Carrots, local'), qty: 150, unit: 'g' })
    await addBatchLine({ typed: 'onion' })
    await addBatchLine({ typed: 'garlic', qty: 4, unit: 'count' })
    const pick = lineNamed('Serranos')
    expect(pick?.input_kind === 'harvest' && pick.harvest_log_id === serrano.picks[0].harvest_log_id, `the Serranos line is ${pick?.input_kind}`)
    expect(jarLabelled('Reaper, frozen').remaining_amount === '92', `the reaper bag reads ${jarLabelled('Reaper, frozen').remaining_amount} g`)
    expect(jarLabelled('Carrots, local').remaining_count === 3, `the carrot bags read ${jarLabelled('Carrots, local').remaining_count}`)
    gardenAmbient(['Megatron jalapeño', 'Serranos', 'Reaper, frozen'])
    const salt = await saltStep({ pct: '2.5', expectLive: '(800 g)', expectGrams: '20.0', expectAside: 'no weight: onion, garlic',
      expectCard: 'aimed 2.5% · put in 20.0 g = 2.5% of 800 g' })
    expect(salt.base_g === '800' && salt.qty === '20' && salt.salt_base === 'produce', `Appendix C salt wrote ${JSON.stringify(salt)}`)
    await aboutCheckpoint('820', null, false)
    await putItUp({
      method: 'hot_sauce',
      rows: [
        { count: 2, container: '8 oz woozy', place: 'Fridge', name: 'Megatron plain', ph: '3.7' },
        // Row 2 inherits row 1's container and place ("same as the row above"), never its count.
        { count: 2, name: 'Megatron reaper', ph: '3.7', discardDay: '2026-12-08',
          added: [{ search: 'reap', hit: J('Reaper, frozen'), qty: 5, unit: 'g', expectLeft: 'about 87 g left after', submit: 'submit' },
            { typed: 'White vinegar', qty: 72, unit: 'g' }] },
      ],
      made: 910, nextTime: 'more carrot',
    })
    const [plain, reaper] = [jarsOfBatch().find(j => j.label === 'Megatron plain'), jarsOfBatch().find(j => j.label === 'Megatron reaper')]
    expect(plain?.package_count === 2 && plain?.quantity_value === '16', `row 1 jar ${JSON.stringify(plain)}`)
    expect(reaper?.package_count === 2 && reaper?.container_label === '8 oz woozy' && reaper?.use_by_target === '2026-12-08' && reaper?.use_by_basis === 'typed',
      `row 2 jar ${JSON.stringify(reaper)}`)
    expect(jarLabelled('Reaper, frozen').remaining_amount === '87', `the reaper bag reads ${jarLabelled('Reaper, frozen').remaining_amount} g after row 2`)
    expect(state.stages.some(s => s.batch_id === theBatch().id && s.stage_kind === 'noted' && s.note === 'more carrot'), 'Next time was not written')
    await workItOut('batch-detail-output-work-it-out', { within: `[data-jar-id="${plain.id}"]`, figure: /^est\. /, over: 'over 910 g made' })
    await workItOut('batch-detail-output-work-it-out', { within: `[data-jar-id="${reaper.id}"]`, refusal: 'how much is in these bottles' })
    await editMade(905)
    await editLine('Carrots, local', { note: 'Local carrots, 1 bag' })
    await checkPage('Appendix C — finished and edited')
    noRefusals('Appendix C')
  },
}

// ── the page ─────────────────────────────────────────────────────────────────────────────────────────
// The real BottomNav hides while the soft keyboard is up (lib/keyboardChrome.js); at the keyboard-up
// height this stand-in does the same while a text field has focus, and shows otherwise.
const TEXT_ENTRY = (el) => !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'submit', 'file', 'range', 'color'].includes(el.type)))
function StandInNav() {
  const [kbUp, setKbUp] = useState(false)
  useEffect(() => {
    const read = () => setKbUp(window.innerHeight < 600 && TEXT_ENTRY(document.activeElement))
    const later = () => setTimeout(read, 0)
    document.addEventListener('focusin', read)
    document.addEventListener('focusout', later)
    return () => { document.removeEventListener('focusin', read); document.removeEventListener('focusout', later) }
  }, [])
  return (
    <nav aria-label="Main navigation"
      style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: BOTTOM_NAV_HEIGHT_PX, zIndex: 100, background: '#fff',
        borderTop: '1px solid #d4c9be', display: 'flex', alignItems: 'center', justifyContent: 'center',
        font: '10px ui-monospace, monospace', color: '#8a8a8a', visibility: kbUp ? 'hidden' : 'visible' }}>
      real BottomNav element ({BOTTOM_NAV_HEIGHT_PX}px)
    </nav>
  )
}

const origError = console.error
console.error = (...a) => { notes.push(`console.error: ${a.map(String).join(' ').slice(0, 300)}`); origError(...a) }
window.addEventListener('error', (e) => fail(`page error: ${e.message}`))
window.addEventListener('unhandledrejection', (e) => fail(`unhandled rejection: ${e.reason?.message ?? e.reason}`))

try {
  for (const k of Object.keys(localStorage)) if (k.startsWith('garden:putup-draft:v1:')) localStorage.removeItem(k)
} catch { /* no storage */ }

createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <MemoryRouter initialEntries={['/put-up']}>
      <PutUp />
      <StandInNav />
    </MemoryRouter>
  </AuthProvider>,
)

let result = null
async function run() {
  if (result) return result
  const t0 = performance.now()
  if (!WALKS[WALK]) fail(`no walk named ${WALK}`)
  else {
    try { await WALKS[WALK]() } catch (e) { fail(`the walk stopped: ${e.message}`) }
  }
  result = {
    walk: WALK, vw: innerWidth, vh: innerHeight, font: window.__fontPin ? { faces: window.__fontPin.faces, failed: window.__fontPin.failed?.length ?? 0 } : null,
    failures: [...failures], notes: [...notes, ...state.unknown.map(p => `unplanned GET ${p}`)],
    ...counts, writes: state.calls.filter(c => c.method !== 'GET').length, ms: Math.round(performance.now() - t0),
  }
  document.title = `${WALK}: ${result.failures.length ? `FAIL ${result.failures.length}` : 'PASS'}`
  document.getElementById('verdict').textContent = JSON.stringify(result)
  return result
}
window.__walk = { ready: () => !!document.querySelector('[aria-label="Put-Up view"]'), run, state }

// V4-ICON-001 slice 4 — real-browser render of the five surfaces this lane rewires.
//
// Why this entry exists: iconWire4.test.jsx proves the right registry entry is MOUNTED, but jsdom
// has no layout engine and no font stack. Two questions here are purely rendering ones and jsdom
// answers 0 to both: whether three 14px drops still fit a one-third-width chip once they stop being
// text glyphs and become replaced boxes, and whether a 22px SVG still centres in the timeline's
// 32px node once it stops being a 15px emoji sitting on a baseline.
//
// `?surface=` picks the frame; the shot script visits all five. Separate entry per the established
// pattern in this directory, so nothing in the other harness entries moves.
//
// FIDELITY, stated rather than assumed. `overwinter` and `notify` mount the REAL components.
// `inventory-type` mounts ChoiceGrid with the exact option mapping InventoryAdd.jsx:322 passes —
// not the whole page, which would need a dozen API stubs to reach one picker — so it is faithful to
// the props, not to the surrounding form. `water-depth` and `life-story` mount their real
// components; those two ARE the whole surface.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import ChoiceGrid from '../../src/components/forms/ChoiceGrid.jsx'
import WaterDepthChips from '../../src/components/WaterDepthChips.jsx'
import LifeStoryTimeline from '../../src/components/planting/LifeStoryTimeline.jsx'
import NotifyButton from '../../src/components/NotifyButton.jsx'
import OverwinterPrompt from '../../src/components/planting/OverwinterPrompt.jsx'
import { INVENTORY_TYPES } from '../../src/lib/inventoryEnums.js'

const SURFACE = new URLSearchParams(location.search).get('surface') || 'overwinter'

const realFetch = window.fetch.bind(window)
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url
  const path = url.startsWith('http') ? new URL(url).pathname : url
  if (!path.startsWith('/api/')) return realFetch(input, init)
  await new Promise(r => setTimeout(r, 30))            // a plausible mobile round trip
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
}

let firstError = null
window.addEventListener('error', e => { firstError ??= e.message })
window.addEventListener('unhandledrejection', e => { firstError ??= String(e.reason?.message ?? e.reason) })

// Every milestone dated, so the timeline draws all five and the transplanted/planted_out adjacency
// this lane drew a glyph FOR is actually in the frame.
const PLANTING = {
  id: 'p1', name: 'Sungold Cherry Tomato',
  sown_at: '2026-02-01', germinated_at: '2026-02-10', transplanted_at: '2026-04-15',
  planted_out_at: '2026-05-20', first_harvest_at: '2026-06-30',
}

// NotifyButton resolves window.Notification.permission in a useState initializer, so the stub has
// to be in place before ITS body runs. Setting it in the parent's body works because React renders
// depth-first and synchronously: this runs, then the child mounts, then the next sibling's parent.
function NotifyAt({ permission }) {
  window.Notification = { permission, requestPermission: async () => permission }
  return <NotifyButton enabled eventCount={5} harvestCount={2} />
}

const Cap = ({ children }) => <div className="cap">{children}</div>

// data-shot-scope marks the subtree THIS LANE CHANGED. The emoji assertion is scoped to it, and
// anything pictographic outside it is REPORTED rather than failed — OverwinterPrompt's trigger
// button carries a scarf emoji that is not in this lane's file set, and silently folding it into a
// pass or a fail would both be wrong.
const SURFACES = {
  overwinter: () => (
    <MemoryRouter>
      <div data-shot-scope>
        <Cap>OverwinterPrompt — real component, sheet opened</Cap>
        <OverwinterPrompt planting={PLANTING} onUpdated={() => {}} />
      </div>
    </MemoryRouter>
  ),
  'inventory-type': () => (
    <div data-shot-scope>
      <Cap>InventoryAdd type picker — ChoiceGrid, the mapping InventoryAdd.jsx:322 passes</Cap>
      <ChoiceGrid
        layout="grid" columns={2} ariaLabel="Type" value="durable" onChange={() => {}}
        options={INVENTORY_TYPES.map(t => ({ value: t.value, label: t.label, iconName: t.iconName, description: t.example }))}
      />
    </div>
  ),
  'water-depth': () => (
    <div data-shot-scope>
      <Cap>WaterDepthChips — full variant (EventNew / LogMany batch)</Cap>
      <WaterDepthChips value="normal" onChange={() => {}} />
      <Cap>WaterDepthChips — small, anchors off (LogMany per-row override)</Cap>
      <WaterDepthChips value="deep" onChange={() => {}} small showAnchors={false} idPrefix="row-depth" />
    </div>
  ),
  'life-story': () => (
    <div data-shot-scope>
      <Cap>LifeStoryTimeline — all five milestones; rows 3 and 4 are the adjacency</Cap>
      <LifeStoryTimeline planting={PLANTING} />
    </div>
  ),
  notify: () => (
    <div data-shot-scope>
      <Cap>NotifyButton — granted / denied / default (NOTIFY_ENABLED forced on)</Cap>
      <NotifyAt permission="granted" />
      <NotifyAt permission="denied" />
      <NotifyAt permission="default" />
    </div>
  ),
}

createRoot(document.getElementById('root')).render(React.createElement(SURFACES[SURFACE] ?? SURFACES.overwinter))

const PICTOGRAPHIC = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}]/gu

// The measured subtree, narrowed per surface where the mounted component is WIDER than what this
// lane changed. `overwinter` mounts the whole of OverwinterPrompt so the sheet is reachable, but
// this lane only rewired the PICKER inside it — the trigger button above it carries a scarf emoji
// that belongs to OverwinterPrompt.jsx, a file outside this lane's set. Measuring it here would
// fail this gate for someone else's open item; ignoring it would hide a real one. Scoped to the
// radiogroup, it lands in pictographicOutside() and is REPORTED in the run log instead.
const SCOPE_SEL = { overwinter: '[role="radiogroup"]' }
const scope = () =>
  (SCOPE_SEL[SURFACE] && document.querySelector(SCOPE_SEL[SURFACE]))
  ?? document.querySelector('[data-shot-scope]')
  ?? document.body

window.__h = {
  surface: () => SURFACE,
  error: () => firstError,
  // Surface-specific on purpose. "an svg exists" is the right readiness signal for four of the
  // five, but OverwinterPrompt's trigger is text-only — the marks live behind it — so waiting for
  // an svg there waits forever on a page that mounted correctly.
  ready: () => SURFACE === 'overwinter'
    ? [...document.querySelectorAll('button')].some(b => /Overwintering|winter care/i.test(b.getAttribute('aria-label') || ''))
    : document.querySelectorAll('svg').length > 0,

  // OverwinterPrompt renders a trigger; the picker lives behind it. Same shape as iconwire3's
  // openMenu: the wrapper stops propagation, so the opening click does not immediately close it.
  openSheet() {
    const btn = [...document.querySelectorAll('button')]
      .find(b => /Overwintering|winter care/i.test(b.getAttribute('aria-label') || ''))
    if (btn) btn.click()
    return document.querySelectorAll('[role="radiogroup"]').length
  },

  // Containment, not baseline skew. Three of these five surfaces stack the mark ABOVE its text in a
  // column (the chips) or centre it in a fixed circular node (the timeline), so there is no shared
  // line box to measure against and a skew number would be meaningless there. What IS meaningful
  // everywhere: the mark must sit inside the labelled thing it belongs to, at a real size.
  icons() {
    const vw = window.innerWidth
    // The nearest ancestor that carries text — the card, chip or row the mark belongs to. This is
    // also the never-mark-alone check: if no ancestor up to the scope root has text, the icon is
    // reading by itself.
    const labelled = (svg) => {
      let el = svg.parentElement
      while (el && el !== document.body) {
        if (el.textContent.trim()) return el
        el = el.parentElement
      }
      return null
    }
    return [...scope().querySelectorAll('svg')].map(svg => {
      const r = svg.getBoundingClientRect()
      const host = labelled(svg)
      const hr = host?.getBoundingClientRect()
      return {
        label: (host?.textContent || svg.getAttribute('aria-label') || '?').trim().replace(/\s+/g, ' ').slice(0, 32),
        w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        fits: r.left >= -0.5 && r.right <= vw + 0.5,
        // Inside its own card/chip/row, with a half-pixel of slack for subpixel rounding.
        contained: Boolean(hr) && r.top >= hr.top - 0.5 && r.bottom <= hr.bottom + 0.5
          && r.left >= hr.left - 0.5 && r.right <= hr.right + 0.5,
        visible: svg.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }),
        named: svg.getAttribute('aria-label'),
        hidden: svg.getAttribute('aria-hidden') === 'true',
      }
    })
  },

  // Scoped to the rewired subtree; `outside` is reported so a known out-of-lane emoji is visible
  // in the log rather than swallowed by either verdict.
  pictographic: () => scope().textContent.match(PICTOGRAPHIC) ?? [],
  pictographicOutside: () => {
    const inner = scope().textContent
    const all = document.body.textContent.replace(inner, '')
    return all.match(PICTOGRAPHIC) ?? []
  },
  textOf: (sel) => [...scope().querySelectorAll(sel)].map(e => e.textContent.trim().replace(/\s+/g, ' ')),
  docOverflows: () => document.documentElement.scrollWidth > window.innerWidth,
}

// Live verdict strip, same pattern as iconwire3.jsx.
let ticks = 0
const paint = () => {
  const el = document.getElementById('verdict')
  if (!window.__h.ready()) { el.textContent = 'booting…'; if (++ticks < 20) setTimeout(paint, 200); return }
  const icons = window.__h.icons()
  const emoji = window.__h.pictographic()
  const loose = icons.filter(i => !i.contained || !i.w || !i.fits)
  const ok = !firstError && !emoji.length && !loose.length && !window.__h.docOverflows()
  el.style.background = ok ? '#2d6a4f' : '#a4161a'
  el.textContent = firstError
    ? 'ERROR: ' + firstError
    : `${SURFACE} @${window.innerWidth}px · ${icons.length} svg · `
      + (emoji.length ? 'EMOJI LEFT: ' + emoji.join('') : 'no emoji in scope')
      + ' · ' + (loose.length ? 'LOOSE: ' + loose.map(l => l.label).join(', ') : 'all marks inside their row')
  if (++ticks < 24) setTimeout(paint, 250)
}
setTimeout(paint, 200)

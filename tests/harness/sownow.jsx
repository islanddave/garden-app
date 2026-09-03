// V4-SOWMOREMENU-001 (BD-067) — real-browser look at the two Sow Now doors this row adds, at
// Dave's geometry.
//
// Why this entry exists: the vitest suite proves both doors EXIST, point at /sow, and sit in the
// right document order — it cannot show what they look like, and both are affordances whose whole
// job is being noticed. Dave's report was "I can't find it anywhere"; a row that passes every
// assertion and still reads as decoration would not fix that. jsdom also returns zero for every
// getBoundingClientRect(), so the 44px tap floor the component sets is unverifiable there.
//
// The lead region is rendered in BOTH its states side by side, because the empty state is the one
// that changed contract (it used to render nothing at all) and it is also the state Dave will see
// on most days of the year — the closing-window state is the rarer one.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import CultivationLead from '../../src/components/today/CultivationLead.jsx'

// Shaped so the real sow engine marks it window_closing on the fixed date below, rather than
// hand-forging a line: lettuce is fall-hardy, so a cool annual direct sow closes at FFobs - dtm.
// Same fixture family the CultivationLead unit tests use, for one vocabulary.
const TODAY = '2026-08-12'
const CLOSING = [{
  variety_name: 'Winter Density', item_name: 'Lettuce packet', crop_type_slug: 'lettuce',
  // dtm retuned 72 -> 58 by BUG-FROSTANCHORERA5-001, which moved FFobs 10-29 -> 10-15: the close is
  // FFobs - dtm, so holding the same Aug 18 close (6 days from TODAY, inside the 10-day closing
  // window) costs the same 14 days off dtm. Same convention the CultivationLead unit tests use —
  // retune the input, keep the case the harness is showing.
  lifecycle: 'annual', sow_season: 'cool', days_to_maturity_max: 58, days_to_maturity_min: null,
  direct_sow_timing: 'as soon as the soil can be worked', start_method: null,
}]
// dtm 30 -> closes Sep 15, 34 days out: open, NOT closing. The engine yields no line, which is the
// empty case — reached through the real engine rather than by passing it an empty array, so the
// harness shows the state Dave actually gets rather than a degenerate one.
const NOT_CLOSING = [{ ...CLOSING[0], variety_name: 'Buttercrunch', days_to_maturity_max: 30 }]

// The component self-fetches /api/inventory-items/sow-candidates through useApiFetch. Stub at the
// network layer so the REAL component and the REAL engine run — mocking the component's own module
// would test the harness instead of the code.
let payload = { items: [] }
const realFetch = window.fetch
window.fetch = (url, ...rest) => (
  String(url).includes('/api/inventory-items/sow-candidates')
    ? Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    : realFetch(url, ...rest)
)

function Case({ label, items }) {
  payload = { items }
  return (
    <>
      <div className="case-label">{label}</div>
      <MemoryRouter><CultivationLead todayISO={TODAY} /></MemoryRouter>
    </>
  )
}

// Rendered sequentially rather than in one tree: `payload` is module-level and each mount reads it
// at fetch time, so two simultaneous mounts would race for the same variable and both show whichever
// case rendered last. Mounting one, letting its fetch settle, then mounting the next is what keeps
// the two cases genuinely different on screen.
async function run() {
  const root = createRoot(document.getElementById('root'))
  const settle = () => new Promise(r => setTimeout(r, 120))

  payload = { items: CLOSING }
  root.render(<Case label="A · a window is closing" items={CLOSING} />)
  await settle()
  const withLine = document.querySelector('[data-testid="cultivation-lead"]')
  const lineRect = withLine?.getBoundingClientRect()
  const lineText = withLine?.textContent ?? '(absent)'
  const lineHref = withLine?.getAttribute('href') ?? '(none)'

  // Freeze case A's markup so both states stay on screen together for the screenshot, then mount B
  // live underneath it. A static clone cannot race the module-level payload the way a second live
  // mount would.
  const frozen = document.createElement('div')
  frozen.innerHTML = document.getElementById('root').innerHTML
  const holder = document.createElement('div')
  document.getElementById('root').replaceWith(holder)
  holder.id = 'root'
  holder.appendChild(frozen)
  const live = document.createElement('div')
  holder.appendChild(live)

  payload = { items: NOT_CLOSING }
  createRoot(live).render(<Case label="B · nothing closing (most of the year)" items={NOT_CLOSING} />)
  await settle()
  const bare = live.querySelector('[data-testid="cultivation-lead"]')
  const bareRect = bare?.getBoundingClientRect()

  const ok = (v) => (v ? 'PASS' : 'FAIL')
  const verdict = [
    `A text: ${lineText}`,
    `A href: ${lineHref}  h=${lineRect ? Math.round(lineRect.height) : 0}px  ${ok(lineRect && lineRect.height >= 44)} (>=44)`,
    `B text: ${bare?.textContent ?? '(absent)'}`,
    `B href: ${bare?.getAttribute('href') ?? '(none)'}  h=${bareRect ? Math.round(bareRect.height) : 0}px  ${ok(bareRect && bareRect.height >= 44)} (>=44)`,
    `B present at all: ${ok(!!bare)}  <- the contract this row reversed`,
    `width: ${window.innerWidth}px`,
  ].join('\n')
  const el = document.getElementById('verdict')
  el.textContent = verdict
  el.style.background = verdict.includes('FAIL') ? '#b94a3a' : '#4a7c59'
}

run()

// Mobile layout-measurement harness — entry point.
//
// Mounts the REAL EventNew (and therefore the real PostSaveFeedback, PlantingSelect, SelectChip,
// Sheet) at mobile geometry with only two things stubbed: auth and network. Everything that affects
// layout — the components, their inline styles, the viewport meta, the Sheet chrome — is the app's.
//
// Why this exists: the in-app Browser pane is NOT Dave's signed-in Chrome, so loading the app there
// lands on the Clerk gate and no layout can be measured; and jsdom has no layout engine at all, so
// no vitest test in this repo can answer "is Save above the fold at 390x500".
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import EventNew from '../../src/pages/EventNew.jsx'
import Sheet from '../../src/components/forms/Sheet.jsx'
import { ToastProvider } from '../../src/context/ToastContext.jsx'
import { OverlaySurfaceProvider, OverlayDirtyProvider } from '../../src/context/OverlayContext.jsx'
import { P, BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'
import { fixtureFor, resetEventSeq } from './stubs/fixtures.js'
import { installCounters, resetCounters, readCounters, measureA, measureC, viewport, settle, waitFor, tap, typeInto, byText, qtyInput, qtyChip, saveButton, plantingInput, yieldMacro, sleepReal, blurActive } from './harnessApi.js'
import { runHarvestScript } from './script.js'

// ── Network stub ───────────────────────────────────────────────────────────────────────────────
// src/lib/api.js resolves every path against import.meta.env.VITE_API_* which is undefined here, so
// requests arrive as bare same-origin paths ('/api/plants'). Intercepting global fetch keeps the
// real api.js seam (timeouts, headers, error mapping) in the loop — only the wire is fake.
const netLog = []
const realFetch = window.fetch.bind(window)
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url
  const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url
  if (!path.startsWith('/api/')) return realFetch(input, init)
  const method = (init.method || 'GET').toUpperCase()
  netLog.push({ method, path })
  const body = fixtureFor(path, method)
  // A few macrotask turns of latency, not zero and NOT setTimeout: a synchronously-resolved promise
  // hides the ordering a real round trip exposes, but setTimeout is clamped to ~1s in a hidden tab
  // (see harnessApi.js §Scheduling) and would dominate every measured run.
  for (let i = 0; i < 3; i++) await yieldMacro()
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

// ── Deterministic starting state ───────────────────────────────────────────────────────────────
// EventNew reads sticky prefs from localStorage (lastHarvestUnit, logone.lastProject, the planting
// key). Left alone, a second run would start from a different form state than the first and the tap
// counts would not be comparable.
function resetLocalState() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (/^(logone\.|quicklog\.|lastHarvest)/.test(k)) localStorage.removeItem(k)
    }
  } catch { /* storage unavailable — nothing to reset */ }
  resetEventSeq()
  netLog.length = 0
}

// ── Surfaces ───────────────────────────────────────────────────────────────────────────────────
// 'overlay'  — reproduces App.jsx:188 (`/log`, overlayable, size='full') wrapped in the same chrome
//              OverlayHost applies: Sheet + OverlaySurfaceProvider + OverlayDirtyProvider.
//              Replicated rather than imported from App.jsx so the harness does not drag the whole
//              route tree (and its auth/router assumptions) in. If App.jsx's OverlayHost or the
//              route's `size` changes, change this to match.
// 'fullpage' — the page tree renders the SAME element unwrapped. BottomNav is not mounted (it needs
//              the router/nav tree), so a spacer of the exact height constant stands in for it —
//              the sticky Save's `bottom` offset is BOTTOM_NAV_HEIGHT_PX + 12, so the nav's HEIGHT
//              is the only property of it the measurement depends on.
// `?session=harvest` mounts the WEIGH-IN SESSION (design-weighin-session-20260824.md §11 Slice A
// step 1). Without it the session surface was unreachable here, so the one measurement the
// V4-WEIGHKBDNEXT-001 pads most needed — two pads on screen at once — could not be taken at all.
// Note EventNew's own gate is `harvestSessionParam && !inOverlay`, so this is only live on the
// FULLPAGE surface; requesting it under 'overlay' silently yields the non-session panel, which is
// EventNew's real behaviour and not a harness limitation.
function Harness() {
  const params = new URLSearchParams(location.search)
  const [surface, setSurface] = useState(params.get('surface') || 'overlay')
  const [nonce, setNonce] = useState(0)
  window.__setSurface = (s) => { resetLocalState(); setSurface(s); setNonce(n => n + 1) }
  window.__remount = () => { resetLocalState(); setNonce(n => n + 1) }

  // event_type rides along because the session gate reads `session`, but the harvest PANEL only
  // renders once a type is chosen — without it every session run would start with a tap that has
  // nothing to do with what is being measured.
  //
  // ⚠️ AND THAT IS A KNOWN DIVERGENCE FROM THE REAL SESSION, observed here 2026-08-24. The real
  // weigh-in session URL carries `session=harvest` and NO `event_type`, which is exactly why
  // harvestFabAutoOpen (EventNew.jsx `preselectedEventType === 'harvest'`) does NOT fire there —
  // the tray is the session's picker instead. Adding event_type to satisfy the panel ALSO satisfies
  // that predicate, so the chooser auto-opens here when it would not in prod. Harmless for pad and
  // fold geometry (measure with the chooser dismissed), but do NOT use this mount to reason about
  // auto-open, tray-vs-chooser, or any tap count that includes picking a planting.
  const entry = params.get('session') === 'harvest' ? '/log?session=harvest&event_type=harvest' : '/log'
  const content = <EventNew key={nonce} />

  if (surface === 'overlay') {
    return (
      <MemoryRouter initialEntries={[entry]}>
        <ToastProvider>
          <Sheet open onClose={() => {}} ariaLabel="Log an event" size="full" kind="route">
            <OverlaySurfaceProvider>
              <OverlayDirtyProvider onDirtyChange={() => {}}>{content}</OverlayDirtyProvider>
            </OverlaySurfaceProvider>
          </Sheet>
        </ToastProvider>
      </MemoryRouter>
    )
  }
  return (
    <MemoryRouter initialEntries={[entry]}>
      <ToastProvider>
        {content}
        <div
          data-testid="harness-fake-bottomnav"
          style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: BOTTOM_NAV_HEIGHT_PX, zIndex: 100, backgroundColor: P.white, borderTop: `1px solid ${P.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', font: '10px ui-monospace, monospace', color: P.light }}
        >
          harness stand-in for BottomNav ({BOTTOM_NAV_HEIGHT_PX}px)
        </div>
      </ToastProvider>
    </MemoryRouter>
  )
}

resetLocalState()
installCounters()
createRoot(document.getElementById('root')).render(<Harness />)

// ── Driver API ─────────────────────────────────────────────────────────────────────────────────
// Everything a measurement run needs, so the Browser-pane driver is one call per number.
window.__h = {
  viewport, measureA, measureC, settle, waitFor, tap, typeInto, byText,
  resetCounters, readCounters, runHarvestScript, yieldMacro, sleepReal, blurActive,
  net: () => netLog.slice(),
  surface: (s) => window.__setSurface(s),
  remount: () => window.__remount(),
  ready: () => !!plantingInput(),

  // Drive the form to the exact state measurement A asks about: a planting selected, a quantity
  // filled, and (mode 'keypad') the numeric field focused so the soft keyboard would be open.
  // Emulating the keyboard is the CALLER's job: with interactive-widget=resizes-content the keyboard
  // shrinks the LAYOUT viewport, which is exactly what resizing the browser to 390x500 does.
  async stateA({ quantityMode = 'chip', optionIndex = 0, chipValue = '2' } = {}) {
    await waitFor(() => byText('Harvested'), { label: 'event type grid' })
    tap(byText('Harvested'))
    await settle(10)
    await waitFor(() => qtyInput(), { label: 'harvest panel' })
    tap(plantingInput(), { focus: true })
    await settle(6)
    const lb = await waitFor(() => document.querySelector('[role="listbox"]'), { label: 'listbox' })
    const opts = Array.from(lb.querySelectorAll('[role="option"]'))
    tap(opts[Math.min(optionIndex, opts.length - 1)])
    await settle(10)
    if (quantityMode === 'chip') {
      tap(qtyChip(chipValue))
    } else {
      tap(qtyInput(), { focus: true })
      typeInto(qtyInput(), '3')
      qtyInput().focus()
    }
    await settle(12)
    return measureA()
  },

  async fullRun(opts) { return runHarvestScript(opts) },
}

// eslint-disable-next-line no-console
console.log('[harness] ready — window.__h', { saveButton: !!saveButton() })

// BUG-SHEETOVERSHOOT-001 — geometry across the Sheet CENSUS, not one surface.
//
// WHY THIS EXISTS AND WHY IT IS NOT plantingphotosheet.jsx. That entry answered "does the photo
// sheet fit"; this one answers "what does capping the PAINTED box instead of the CONTENT box do to
// every OTHER Sheet". Sheet.jsx has 21 render sites (7 size='full', 14 peek), so a sizing change
// measured on one surface is an unmeasured change on twenty. Each `?case=` below mounts a REAL
// consumer with real content — a synthetic filler div would answer a question about the filler.
//
// WHAT IT DELIBERATELY DOES NOT DO: no assertions. It reports numbers; the report compares two runs
// (working tree vs HARNESS_BASELINE_SHA, or before/after an edit) and draws the conclusion.
//
// AuthContext IS imported here, unlike plantingphotosheet.jsx. That entry's ban is specific to it:
// it never needed a provider, so not importing one was free. `editdeeplink.jsx` has mounted the real
// AuthProvider on the harness Clerk stub since BUG-EDITDEEPLINKRACE-001, which is the standing proof
// the dual-React trap is not reached through this alias set. The `editor` case needs it (PlantForm's
// FavoriteToggle-adjacent tree uses the strict useAuth), and that case is the TALLEST full-size
// consumer in the census — the one where the cap actually binds.
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DismissRegistryProvider } from '../../src/context/DismissRegistry.jsx'
import { AuthProvider } from '../../src/context/AuthContext.jsx'
import Sheet from '../../src/components/forms/Sheet.jsx'
import PhotoDeleteConfirm from '../../src/components/photo/PhotoDeleteConfirm.jsx'
import BatchUndoConfirm from '../../src/components/BatchUndoConfirm.jsx'
import HarvestTimeframeChips from '../../src/components/HarvestTimeframeChips.jsx'
import HarvestExportSheet from '../../src/components/HarvestExportSheet.jsx'
import PlantingEditor from '../../src/components/PlantingEditor.jsx'

const q = new URLSearchParams(location.search)
const CASE = q.get('case') || 'photodelete'

// Real-shaped fixtures. Long names on purpose: the header wraps at 390px and a short invented name
// makes every panel read 20px shorter than it is on Dave's garden.
const PHOTO = { id: 'ph-1', storage_path: 'plants/pxl_20260830_143012345.jpg', caption: 'North row after the first real rain', taken_at: '2026-08-30' }
const PROJECTS = [{ id: 'proj-1', name: 'Spring 2026', status: 'active', parent_project_id: null, is_public: true }]
const PLANT = {
  id: 'plant-2', name: 'Wild Bergamot (north row)', project_id: 'proj-1', project_name: 'Spring 2026',
  quantity: 3, status: 'seedling', notes: 'Volunteer clump moved from the ditch; keep an eye on mildew.',
  variety: 'Black Krim', variety_id: 'var-1',
  variety_ref: { id: 'var-1', name: 'Black Krim', species: 'Solanum lycopersicum' },
}
// {crop_type_slug, display_name}, NOT bare strings — HarvestExportSheet maps them to
// {value: c.crop_type_slug, label: c.display_name}, so a string array renders eight EMPTY chips and
// the case measures a shorter panel than the surface really is. Caught by looking at the screenshot.
const CROPS = ['Tomato', 'Cucumber', 'Zucchini', 'Bean (bush)', 'Pepper (sweet)', 'Kale', 'Lettuce', 'Basil']
  .map((n) => ({ crop_type_slug: n.toLowerCase().replace(/[^a-z]+/g, '-'), display_name: n }))

// Every API this page can reach, answered locally. A real round trip would make readiness a timer.
const realFetch = window.fetch.bind(window)
const json = (v) => Promise.resolve(new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } }))
window.fetch = (input, init) => {
  const url = String(typeof input === 'string' ? input : input?.url ?? '')
  if (!url.includes('/api/')) return realFetch(input, init)
  if (url.includes('/api/projects')) return json(PROJECTS)
  if (url.includes('/api/locations')) return json([{ id: 'loc-1', name: 'North bed' }, { id: 'loc-2', name: 'Hoop house' }])
  if (url.includes('/api/plants')) return json([PLANT])
  if (url.includes('/api/harvests')) return json([])
  if (url.includes('/api/varieties')) return json([{ id: 'var-1', name: 'Black Krim' }])
  return json([])
}
const apiFetch = (path, opts) => window.fetch(path.startsWith('/') ? path : `/api/${path}`, opts)

function Case() {
  switch (CASE) {
    case 'photodelete':
      return <PhotoDeleteConfirm open photo={PHOTO} coverFor={[{ id: 'plant-2', name: 'Wild Bergamot (north row)' }]} onCancel={() => {}} onConfirm={() => {}} />
    case 'batchundo':
      return <BatchUndoConfirm open batch={{ id: 'b-1', kind: 'water', occurred_at: '2026-08-30T14:30:00Z' }} count={7} onCancel={() => {}} onConfirm={() => {}} />
    case 'timeframe':
      return <HarvestTimeframeChips value="" onChange={() => {}} seasonYears={[2026, 2025, 2024, 2023, 2022]} />
    case 'export':
      return <HarvestExportSheet open onClose={() => {}} cropOptions={CROPS} seasonYears={[2026, 2025, 2024]} initialCrops={['tomato']} />
    case 'editor':
      return (
        <Sheet open title="Edit planting" onClose={() => {}} size="full">
          <PlantingEditor mode="edit" plant={PLANT} plants={[PLANT]} projects={PROJECTS} fetch={apiFetch}
            onUpdated={() => {}} onDeleted={() => {}} onArchived={() => {}} onClose={() => {}} />
        </Sheet>
      )
    // The peek worst case: content far taller than 85vh, so the cap BINDS. Nothing real is measured
    // here — it exists to show what the peek branch does when its cap is the active constraint.
    case 'peektall':
      return (
        <Sheet open title="Peek with over-tall content" onClose={() => {}}>
          <div data-testid="filler" style={{ height: 2000, background: 'linear-gradient(#eee, #ccc)' }} />
        </Sheet>
      )
    default:
      return <div id="bad-case">unknown case: {CASE}</div>
  }
}

function Harness() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    // DOM-DERIVED readiness, not a timer. The editor and the export sheet both settle asynchronously
    // (locations fetch, crop list), and a fixed wait measured one of them mid-render on the first run.
    const want = () => {
      // HarvestTimeframeChips owns a CHIP ROW whose sheet opens on tap — there is no `open` prop to
      // pass. Driving the real affordance is also the honest thing: it is the only way this Sheet is
      // ever reached. Without it the first run measured a null panel and the census row was blank.
      const trigger = document.querySelector('[aria-haspopup="dialog"]')
      if (CASE === 'timeframe' && trigger && !document.querySelector('[role="dialog"]')) trigger.click()
      const panel = document.querySelector('[role="dialog"]')
      if (!panel) return false
      if (CASE === 'editor') return !!document.getElementById('planting-editor') || /Save/.test(panel.textContent)
      if (CASE === 'export') return /Export|Download|Copy/.test(panel.textContent)
      return panel.textContent.trim().length > 0
    }
    let tries = 0
    const poll = () => {
      if (want() || tries++ > 200) { setReady(true); return }
      setTimeout(poll, 50)
    }
    poll()
  }, [])
  return (
    <AuthProvider>
      <DismissRegistryProvider>
        <Case />
        <span data-testid="harness-ready" data-ready={ready ? '1' : '0'} style={{ display: 'none' }} />
      </DismissRegistryProvider>
    </AuthProvider>
  )
}

createRoot(document.getElementById('root')).render(<Harness />)

// ── measurements ─────────────────────────────────────────────────────────────────────────────────
const round = (r) => (r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) } : null)
const panelEl = () => document.querySelector('[role="dialog"]')

window.__h = {
  ready() { return document.querySelector('[data-testid="harness-ready"]')?.dataset.ready === '1' },
  sheet() {
    const p = panelEl()
    if (!p) return null
    const cs = getComputedStyle(p)
    const r = p.getBoundingClientRect()
    const padTop = parseFloat(cs.paddingTop) || 0
    const padBottom = parseFloat(cs.paddingBottom) || 0
    // The children the CONSUMER supplied plus Sheet's own chrome, measured from the flow rather than
    // from scrollHeight: Chrome's treatment of a scroll container's bottom padding in scrollHeight is
    // the very thing one of the rejected fixes turns on, so it must not be the instrument.
    const kids = [...p.children]
    const first = kids[0]?.getBoundingClientRect()
    const last = kids[kids.length - 1]?.getBoundingClientRect()
    return {
      case: CASE,
      panel: round(r),
      maxHeightComputed: cs.maxHeight,
      boxSizing: cs.boxSizing,
      padTop, padBottom,
      panelClientHeight: p.clientHeight,
      panelScrollHeight: p.scrollHeight,
      panelScrolls: p.scrollHeight > p.clientHeight + 0.5,
      // How much room the consumer's own content actually gets before it must scroll.
      visibleContentPx: Math.round(p.clientHeight - padTop - padBottom),
      // Natural (unclipped) height of everything inside, independent of the cap.
      naturalContentPx: first && last ? Math.round(last.bottom - first.top + p.scrollTop) : null,
      topAboveViewport: r.top < -0.5,
      bottomOnEdge: Math.abs(r.bottom - innerHeight) < 1,
      emptyAbovePx: Math.round(r.top),
      // Sheet's grab handle is children[0]; it is the first thing an overshoot eats.
      handleTop: first ? Math.round(first.top) : null,
      handleVisible: kids[0] && typeof kids[0].checkVisibility === 'function' ? kids[0].checkVisibility() : null,
      closeBtn: round(p.querySelector('[data-sheet-close="true"]')?.getBoundingClientRect()),
      viewport: { w: innerWidth, h: innerHeight },
    }
  },
  all() { return { sheet: this.sheet() } },
}

if (q.get('verdict') !== '0') {
  const tick = () => {
    const v = document.getElementById('verdict')
    if (!v) return
    if (!window.__h.ready()) { v.textContent = `${CASE} · settling…`; setTimeout(tick, 250); return }
    const s = window.__h.sheet()
    if (!s) { v.textContent = `${CASE} · NO PANEL`; return }
    v.style.background = s.topAboveViewport ? '#b14a3c' : '#4a7c59'
    v.textContent = `${s.case} · vp ${s.viewport.w}x${s.viewport.h} · panel ${s.panel.h}px @y=${s.panel.y} · max ${s.maxHeightComputed} · ${s.boxSizing} · content ${s.visibleContentPx}/${s.naturalContentPx} · ${s.topAboveViewport ? 'OVERSHOOT' : 'ok'}`
  }
  setTimeout(tick, 400)
}

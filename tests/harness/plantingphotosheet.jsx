// V4-PHOTOBULK-001 D4b — PlantingPhotoSheet at Dave's geometry. It shipped in v4.75.0 having never
// been rendered in a browser.
//
// WHY. This sheet EXISTS because the inline version failed on a phone, and the failure was found by
// a screenshot, not by a test: ten staged files grew the planting card to 802px and pushed the next
// card off an 844px screen. The replacement was then shipped on the strength of ~12,900 green jsdom
// assertions, none of which can see a pixel — jsdom returns zero for every getBoundingClientRect and
// rasterises nothing, so "the strip fits", "nothing is clipped" and "the controls are tappable" were
// all unfalsifiable at the moment this went to prod.
//
// The questions this answers, none of which a vitest run can:
//   1. At 390x844, does anything overflow horizontally — the page, or the sheet panel itself?
//   2. The sheet's whole purpose is a BATCH. Does the staged strip lay out for 1, for 5, and for the
//      10-file cap (a 20-pick, which is what "grab everything from the walk" actually looks like)?
//   3. size="full" was chosen so the strip "has room for two rows of 88px tiles". Does the strip
//      actually GET that room, or does it cap itself while the sheet sits mostly empty?
//   4. Is every control at or above the app's own 44px tap floor (T.tapMinHeight)?
//   5. Is the action row — the Choose-photos trigger, Clear, Close — inside the viewport AND inside
//      the panel's own scroll window, i.e. reachable without hunting?
//
// WHAT IT DELIBERATELY DOES NOT IMPORT: AuthContext. The retired photostrips entry wrapped its
// subject in the real AuthProvider (FavoriteToggle needs one) and hit a dual-React "Invalid hook
// call" that defeated two diagnoses. Nothing here reaches that module; Clerk is stubbed by the
// harness vite alias, exactly as quicktag/photobulk do it.
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DismissRegistryProvider } from '../../src/context/DismissRegistry.jsx'
import PlantingPhotoSheet from '../../src/components/photo/PlantingPhotoSheet.jsx'

const q = new URLSearchParams(location.search)
const N = Number(q.get('n') ?? 5)
const FAIL = q.get('fail') === '1'

// A real planting from the live garden, and one of the LONG names — the sheet title is
// `Add photos — ${planting.name}`, so an invented "Plant 1" would make the header look tidier than
// it is at 390px.
const PLANTING = { id: 'pl-bergamot-north', name: 'Wild Bergamot (north row)', project_id: 'pr-natives-2026' }

// Android camera filenames at their real length. They are not rendered in showPreview mode, but they
// are the remove buttons' accessible names and the per-file error rows' companions.
const FILENAMES = Array.from({ length: 20 }, (_, i) => `PXL_20260830_1430${String(12345 + i).padStart(5, '0')}.jpg`)

// A real PNG with real bytes so URL.createObjectURL yields something the browser genuinely paints —
// a tile that fails to decode would collapse and make the strip look shorter than it is. Sage rather
// than the 1x1 the other entries use: a red-ish placeholder in a strip whose status vocabulary
// includes "Failed" makes every screenshot in the report read as an error state.
const PNG_SAGE = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGOYvbEHK2IYWhIAHzp2AcFVsmsAAAAASUVORK5CYII='
), c => c.charCodeAt(0))
const mkFile = (name) => new File([PNG_SAGE], name, { type: 'image/png' })

// ── network, stubbed at the transport ────────────────────────────────────────────────────────────
// The REAL useUploadPhoto state machine runs — mocking the component's own modules would measure the
// harness instead of the code. Only the two transports it reaches are replaced: window.fetch (presign
// + register) and XMLHttpRequest (the S3 PUT, via putWithProgress).
const realFetch = window.fetch.bind(window)
window.fetch = (url, opts, ...rest) => {
  const u = String(url)
  const json = (v, status = 200) => Promise.resolve(new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } }))
  if (u.includes('/api/photos/upload-url') || u.includes('/api/photos/thumb-upload-url')) {
    // FAIL mode fails the presign: it is the earliest branch that reaches the per-file error row,
    // which is the TALLEST staged-tile variant and therefore the one worth measuring.
    if (FAIL) return json({ error: 'Upload service unavailable' }, 503)
    return json({ upload_url: 'https://s3.harness.invalid/put' })
  }
  if (u.startsWith('https://s3.harness.invalid')) return Promise.resolve(new Response('', { status: 200 }))
  if (u.includes('/api/photos')) return json({ id: `ph-${Math.random().toString(36).slice(2, 8)}`, storage_path: 'plants/x.jpg' })
  if (u.includes('/api/')) return json({})
  return realFetch(url, opts, ...rest)
}

// Minimal stand-in for the PUT transport: putWithProgress needs `upload` (progress), load/error/abort
// listeners, and a status. It resolves on the next macrotask so the serial queue really is serial.
class HarnessXHR {
  constructor() {
    this.status = 200
    this.upload = { addEventListener: (t, fn) => { if (t === 'progress') this._prog = fn } }
    this._on = {}
  }
  addEventListener(t, fn) { this._on[t] = fn }
  open() {}
  setRequestHeader() {}
  abort() {}
  send(body) {
    const total = body?.size ?? 1
    setTimeout(() => {
      this._prog?.({ lengthComputable: true, loaded: total, total })
      this._on.load?.()
    }, 10)
  }
}
window.XMLHttpRequest = HarnessXHR

// ── mount ────────────────────────────────────────────────────────────────────────────────────────
function Harness() {
  const [staged, setStaged] = useState(N === 0)
  useEffect(() => {
    if (N === 0) return
    // Drive the REAL hidden input rather than seeding state: that runs handleChange, which is where
    // the maxFiles cap, the "only N at a time" notice and the serial upload queue actually live.
    const t = setTimeout(() => {
      const input = document.getElementById(`planting-sheet-photo-${PLANTING.id}`)
      if (input) {
        const dt = new DataTransfer()
        for (const name of FILENAMES.slice(0, N)) dt.items.add(mkFile(name))
        input.files = dt.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
      // READINESS IS DOM-DERIVED, NOT A TIMER. A fixed wait measured the queue mid-flight on the
      // first run — three tiles still read "Ready", the uploading tile had no remove button, and
      // Clear was absent because isUploading was still true. Every one of those is a control the
      // report is about, so the settled state is the only honest thing to measure. Terminal = every
      // status line is Added or Failed; the queue is serial, so this is also the LAST row's state.
      const settled = () => {
        const s = [...document.querySelectorAll('[data-testid="photo-upload-staged-status"]')]
        return s.length > 0 && s.every(e => e.textContent === 'Added' || e.textContent === 'Failed')
      }
      let tries = 0
      const poll = () => {
        if (settled() || tries++ > 400) { setStaged(true); return }
        setTimeout(poll, 50)
      }
      poll()
    }, 120)
    return () => clearTimeout(t)
  }, [])

  return (
    <DismissRegistryProvider>
      <PlantingPhotoSheet
        open
        onClose={() => {}}
        planting={PLANTING}
        // The card closes the sheet here. The harness must NOT — the terminal state is what we came
        // to measure, and closing it on the last upload would leave nothing on screen.
        onUploaded={() => {}}
      />
      <span data-testid="harness-staged" data-ready={staged ? '1' : '0'} style={{ display: 'none' }} />
    </DismissRegistryProvider>
  )
}

createRoot(document.getElementById('root')).render(<Harness />)

// ── measurements ─────────────────────────────────────────────────────────────────────────────────
const rect = (el) => (el ? el.getBoundingClientRect() : null)
const round = (r) => (r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) } : null)
const panelEl = () => document.querySelector('[role="dialog"]')
const stripEl = () => document.querySelector('[data-testid="photo-upload-staged"]')

window.__h = {
  ready() {
    return document.querySelector('[data-testid="harness-staged"]')?.dataset.ready === '1'
  },
  // Nothing may scroll sideways at 390px — and the PANEL is its own scroller, so a page-level check
  // alone would miss an overflow inside the sheet.
  overflow() {
    const p = panelEl(), s = stripEl()
    return {
      viewport: { w: innerWidth, h: innerHeight },
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      panelScrollWidth: p?.scrollWidth ?? null,
      panelClientWidth: p?.clientWidth ?? null,
      stripScrollWidth: s?.scrollWidth ?? null,
      stripClientWidth: s?.clientWidth ?? null,
    }
  },
  // Does the sheet fit the screen, and how much of the screen does it leave unused? Question 3: the
  // strip caps itself at a CONSTANT, so a mostly-empty sheet above a scrolling strip is the defect
  // shape this measurement exists to expose.
  sheet() {
    const p = panelEl()
    if (!p) return null
    const r = rect(p)
    return {
      panel: round(r),
      panelScrollHeight: p.scrollHeight,
      panelClientHeight: p.clientHeight,
      panelScrolls: p.scrollHeight > p.clientHeight + 0.5,
      maxHeightComputed: getComputedStyle(p).maxHeight,
      // Sheet sits on the bottom edge; anything else means it is off-screen or floating.
      bottomOnEdge: Math.abs(r.bottom - innerHeight) < 1,
      topAboveViewport: r.top < -0.5,
      // Screen left EMPTY above the sheet. Large + a scrolling strip = room the strip was denied.
      emptyAbovePx: Math.round(r.top),
    }
  },
  strip() {
    const s = stripEl()
    if (!s) return { present: false }
    const sr = rect(s)
    const tiles = [...document.querySelectorAll('[data-testid="photo-upload-staged-item"]')]
    const tops = tiles.map(t => Math.round(rect(t).top))
    const rows = new Set(tops).size
    const firstRow = tops.length ? tops.filter(t => t === tops[0]).length : 0
    // A tile is CLIPPED when it falls outside the strip's own scroll window — visible only after
    // scrolling a 216px box inside a sheet that may itself have hundreds of spare pixels.
    const clipped = tiles.filter(t => { const r = rect(t); return r.bottom > sr.bottom + 0.5 || r.top < sr.top - 0.5 }).length
    return {
      present: true,
      rect: round(sr),
      scrollHeight: s.scrollHeight,
      clientHeight: s.clientHeight,
      scrollsInternally: s.scrollHeight > s.clientHeight + 0.5,
      tiles: tiles.length,
      tilesPerRow: firstRow,
      rows,
      tilesOutsideStripWindow: clipped,
      notice: document.querySelector('[data-testid="photo-upload-stage-notice"]')?.textContent ?? null,
      statuses: [...document.querySelectorAll('[data-testid="photo-upload-staged-status"]')].map(e => e.textContent),
    }
  },
  // 44px is the app's own floor (T.tapMinHeight, formStyles.js:35). A control below it on a surface
  // whose entire job is picking and pruning photos by thumb is a mis-tap.
  tapTargets() {
    const p = panelEl()
    if (!p) return null
    const named = {
      trigger: '[data-testid="photo-upload-trigger"]',
      close: '[data-sheet-close="true"]',
      remove: '[data-testid="photo-upload-staged-remove"]',
      clear: '[data-testid="photo-upload-staged-clear"]',
    }
    const out = {}
    for (const [k, sel] of Object.entries(named)) {
      const els = [...p.querySelectorAll(sel)]
      out[k] = {
        count: els.length,
        sizes: els.slice(0, 3).map(e => { const r = rect(e); return { w: Math.round(r.width), h: Math.round(r.height) } }),
        under44: els.filter(e => { const r = rect(e); return Math.min(r.width, r.height) < 44 }).length,
      }
    }
    return out
  },
  // "Reachable" = on screen AND inside the panel's visible scroll window. A control that only exists
  // after scrolling the sheet is not clipped in the CSS sense but is unreachable in the human one.
  actionRow() {
    const p = panelEl()
    if (!p) return null
    const pr = rect(p)
    const probe = (sel) => {
      const el = p.querySelector(sel)
      if (!el) return null
      const r = rect(el)
      return {
        ...round(r),
        onScreen: r.top >= -0.5 && r.bottom <= innerHeight + 0.5,
        insidePanelWindow: r.top >= pr.top - 0.5 && r.bottom <= pr.bottom + 0.5,
        visible: typeof el.checkVisibility === 'function' ? el.checkVisibility() : null,
      }
    }
    return {
      trigger: probe('[data-testid="photo-upload-trigger"]'),
      clear: probe('[data-testid="photo-upload-staged-clear"]'),
      close: probe('[data-sheet-close="true"]'),
      title: p.querySelector('div')?.parentElement ? probe('[role="dialog"] > div:nth-child(2) > div') : null,
    }
  },
  all() {
    return { overflow: this.overflow(), sheet: this.sheet(), strip: this.strip(), tap: this.tapTargets(), action: this.actionRow() }
  },
}

// Verdict bar. `?verdict=0` hides it so a screenshot shows only the surface under test.
if (q.get('verdict') !== '0') {
  const tick = () => {
    const v = document.getElementById('verdict')
    if (!v) return
    if (!window.__h.ready()) { v.textContent = `n=${N}${FAIL ? ' fail' : ''} · staging…`; setTimeout(tick, 250); return }
    const a = window.__h.all()
    const bad =
      a.overflow.docScrollWidth > a.overflow.docClientWidth ||
      (a.overflow.panelScrollWidth ?? 0) > (a.overflow.panelClientWidth ?? 0) ||
      a.sheet.topAboveViewport || !a.sheet.bottomOnEdge ||
      (a.action.trigger && !a.action.trigger.onScreen)
    v.style.background = bad ? '#b14a3c' : '#4a7c59'
    v.textContent =
      `n=${N}${FAIL ? ' fail' : ''} · vp ${a.overflow.viewport.w}x${a.overflow.viewport.h} · panel ${a.sheet.panel.h}px (empty above ${a.sheet.emptyAbovePx}) · ` +
      `strip ${a.strip.present ? `${a.strip.clientHeight}/${a.strip.scrollHeight}px ${a.strip.tiles} tiles ${a.strip.tilesPerRow}/row${a.strip.scrollsInternally ? ' SCROLLS' : ''}` : 'none'} · ` +
      `${a.overflow.docScrollWidth}/${a.overflow.docClientWidth}px ${bad ? 'PROBLEM' : 'ok'}`
  }
  setTimeout(tick, 400)
}

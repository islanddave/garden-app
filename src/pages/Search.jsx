// V4-SEARCH-001 + V4-SEARCH-002 — universal search, hybrid client/server.
// Core three entities (plantings /api/plants, locations /api/locations, varieties /api/varieties)
// stay CLIENT-SIDE: full lists fetched once, filtered in-browser — instant and weak-signal/offline
// tolerant (garden use). The server slice (V4-SEARCH-002) adds GET /api/search?q= (dashboard Lambda):
// projects, events, inventory, photos PLUS notes-column matches on the core three that the client
// filter can't see. Merge rule: client rows win for the core three; server rows dedupe by id and
// append. Server call is debounced 300ms with AbortController (stale responses dropped); a server
// failure degrades gracefully to the client-side experience — never blocks it.
// Voice reuses transcribe.js's Web-Speech wrapper (iOS start/no-speech watchdogs + graceful
// "type it" fallback); the mic only renders where isTranscriptionSupported() is true.
// V4-SEARCHPEEK-001 — inspect a planting result IN PLACE. PANED, not stacked: one Sheet whose
// content swaps results <-> peek at `/search?q=<query>&peek=<plantId>`. See §peek below.
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { Link, useSearchParams, useNavigate, useLocation } from 'react-router-dom'
import { useInOverlaySurface, useOverlaySwap } from '../context/OverlayContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { startLiveTranscription, isTranscriptionSupported } from '../lib/transcribe.js'
import { P, statusLabel } from '../lib/constants.js'
import { PROJECTS_HIDDEN } from '../lib/featureFlags.js'

const norm = s => (s || '').toString().toLowerCase()
const asArray = (d, key) => (Array.isArray(d) ? d : (d?.[key] ?? []))

function MagnifierIcon({ size = 18, color = P.greenDeep }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}
function MicIcon({ size = 18, color = P.greenDeep }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><line x1="12" y1="18" x2="12" y2="21" />
    </svg>
  )
}

const SERVER_DEBOUNCE_MS = 300
const SERVER_MIN_LEN = 2
const EMPTY_SERVER = { plantings: [], projects: [], locations: [], varieties: [], events: [], inventory: [], photos: [] }

// Hoisted from inside Search() unchanged (same values, same keys). They close over nothing but the
// module-level palette, and PeekCard below has to be a MODULE-scope component: while the peek is up
// the debounced server search still resolves and re-renders Search, and a component declared inside
// the render body is a new type on every render -> remount -> the focus we just moved to the peek
// heading is thrown on the floor mid-read.
const rowStyle = { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, textDecoration: 'none', marginBottom: 8 }
const nameStyle = { fontWeight: 700, color: P.dark, fontSize: '0.92rem' }
const subStyle = { fontSize: '0.75rem', color: P.light }
const sectionHead = { fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: P.mid, margin: '16px 2px 8px' }
const chev = <span aria-hidden="true" style={{ color: P.light }}>{'›'}</span>

// ── §peek — V4-SEARCHPEEK-001 ─────────────────────────────────────────────────────────────────────
//
// SHAPE (locked by Dave 2026-07-16, not re-litigated here): PANED, not stacked. There is exactly ONE
// Sheet — App.jsx's OverlayHost, registered in the DismissRegistry as kind:'route' — and this file
// swaps what it CONTAINS. Opening a peek is a same-route navigation (`/search` -> `/search?q&peek`),
// so react-router keeps the very same <OverlayHost> element mounted: Sheet's [open] effect never
// re-runs, the refcounted body scroll-lock never re-counts, and no second registry entry is created.
// That is what "depth-1 invariant intact" means mechanically, and SearchPeek.test.jsx asserts the
// stack depth rather than taking it on faith.
//
// (Naming collision worth knowing: Sheet's own `size="peek"` prop is the 85vh height variant and has
// nothing to do with this feature.)
//
// BACK (Dave is Android-only, so this is the primary gesture, not an edge case): the peek PUSHES a
// history entry — `swap(url, { replace: false })` — where every other in-overlay content swap in the
// app replaces. Pushing is the whole reason Back lands on the results list instead of tearing the
// sheet down. Nothing in DismissRegistry competes for it: decideBack returns NONE for a kind:'route'
// surface and isArmable() excludes it, so no Back marker is ever armed while search is open and the
// router owns the gesture outright.
//
// READ-ONLY BY CONSTRUCTION. The peek renders text and one link; it holds no input, so there is
// nothing to report through useReportOverlayDirty and no dirty-guard wiring here (deliberate — see
// the report). If a future slice makes any field editable, wire the V4-DIRTYGUARDSWEEP-001 contract
// then; do not invent a second mechanism.
//
// NO SERVER CHANGE, VERIFIED. Everything below comes off the `/api/plants` row the page already
// fetched — including all 21 variety_ref subfields — plus a location NAME resolved out of the
// `/api/locations` list already in hand. Live prod (2026-08-20, 235 live plantings): 232 carry a
// cultivar; species 214, dtm_min 173, sun 206, lifecycle 225, crop_type_slug 232, growth_habit 201.
const peekShellStyle = { ...rowStyle, padding: 0, gap: 0, alignItems: 'stretch', minHeight: 44, overflow: 'hidden' }
const peekRowLinkStyle = { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', flex: 1, minWidth: 0, textDecoration: 'none' }
const peekBtnStyle = { flexShrink: 0, minWidth: 52, padding: '0 10px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', borderLeft: `1px solid ${P.border}`, color: P.greenDeep, fontFamily: 'inherit', fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', cursor: 'pointer' }
const backBtnStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 44, padding: '0 10px 0 4px', margin: '0 0 4px -4px', background: 'transparent', border: 'none', color: P.greenDeep, fontFamily: 'inherit', fontSize: '0.85rem', fontWeight: 700, cursor: 'pointer' }
const peekTitleStyle = { fontSize: '1.05rem', fontWeight: 700, color: P.dark, margin: '0 0 2px', outline: 'none' }
const peekFieldStyle = { padding: '9px 2px', borderBottom: `1px solid ${P.border}` }
const peekLabelStyle = { fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: P.mid, marginBottom: 2 }
const peekValueStyle = { fontSize: '0.9rem', color: P.dark, lineHeight: 1.45, wordBreak: 'break-word' }
const openFullStyle = { display: 'block', marginTop: 14, padding: '12px 14px', background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, textDecoration: 'none', color: P.greenDeep, fontWeight: 700, fontSize: '0.9rem' }

// 'part_shade' -> 'Part shade'. The cultivar columns are snake_case enums and prose alike.
const humanize = s => {
  const t = (s ?? '').toString().replace(/_/g, ' ').trim()
  return t ? t[0].toUpperCase() + t.slice(1) : ''
}
const clip = (s, n) => {
  const t = (s ?? '').toString().trim()
  return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t
}
// cultivar.species holds the FULL binomial on some rows ('Solanum lycopersicum') and the bare
// epithet on others ('palmatum'), so genus can only be prefixed when it is not already there.
const botanicalName = vr => {
  const g = (vr?.genus ?? '').trim(), s = (vr?.species ?? '').trim()
  if (!s) return g || null
  if (!g) return s
  return s.toLowerCase().startsWith(g.toLowerCase()) ? s : `${g} ${s}`
}
const maturityRange = vr => {
  const lo = vr?.days_to_maturity_min, hi = vr?.days_to_maturity_max
  if (lo == null && hi == null) return null
  if (lo != null && hi != null && lo !== hi) return `${lo}–${hi} days`
  return `${lo ?? hi} days`
}
// Dates land as 'YYYY-MM-DD…' strings; sliced, never Date-parsed, so no timezone can shift the day.
const isoDay = v => (v ? String(v).slice(0, 10) : null)

function PeekField({ label, value }) {
  if (value == null || value === '') return null
  return (
    <div style={peekFieldStyle}>
      <div style={peekLabelStyle}>{label}</div>
      <div style={peekValueStyle}>{value}</div>
    </div>
  )
}

function PeekCard({ planting, locationName, headingRef }) {
  const vr = planting.variety_ref || null
  const varietyName = vr?.name && vr.name !== planting.name ? vr.name : null
  const qty = planting.qty_current ?? planting.quantity ?? null
  return (
    <div data-testid="search-peek">
      {/* tabIndex -1: a focus TARGET for the content swap, never a Tab stop — and excluded from
          Sheet's focusable ring by its :not([tabindex="-1"]) selector, so it cannot become the
          sheet's focus-on-open target either. */}
      <h2 ref={headingRef} tabIndex={-1} style={peekTitleStyle}>{planting.name || 'Planting'}</h2>
      <div style={{ ...subStyle, marginBottom: 6 }}>Planting</div>
      <PeekField label="Status" value={planting.status ? statusLabel(planting.status) : null} />
      <PeekField label="Variety" value={varietyName} />
      <PeekField label="Crop type" value={vr?.crop_type_slug ? humanize(vr.crop_type_slug) : null} />
      <PeekField label="Botanical name" value={botanicalName(vr)} />
      <PeekField label="Where" value={locationName} />
      <PeekField label="Quantity" value={qty == null ? null : String(qty)} />
      <PeekField label="Days to maturity" value={maturityRange(vr)} />
      <PeekField label="Sun" value={vr?.sun_requirements ? humanize(vr.sun_requirements) : null} />
      <PeekField label="Lifecycle" value={vr?.lifecycle ? humanize(vr.lifecycle) : null} />
      <PeekField label="Sown" value={isoDay(planting.sown_at)} />
      <PeekField label="Planted out" value={isoDay(planting.planted_out_at)} />
      <PeekField label="Habit" value={vr?.growth_habit ? clip(vr.growth_habit, 220) : null} />
      <PeekField label="Notes" value={clip(planting.notes, 240) || null} />
      {/* A PLAIN <Link>: no background state, so this deliberately leaves the flyover and lands on
          the full page — exactly what a result row itself does today. */}
      <Link to={`/plantings/${planting.id}`} style={openFullStyle}>Open full details {'›'}</Link>
    </div>
  )
}

export default function Search() {
  const { fetch } = useApiFetch()
  const inOverlay = useInOverlaySurface()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const swap = useOverlaySwap()
  // Seeded from the URL ONCE, so `/search?q=x&peek=y` deep-links (and reloads) to a peek sitting over
  // a POPULATED result list. Not synced back on every keystroke: that would rewrite the URL per
  // character and re-fire the [params]-keyed autofocus effect below on each one. The query is
  // captured into the URL at the moment a peek opens, which is the only moment it has to be there.
  const [q, setQ] = useState(() => params.get('q') ?? '')
  const [plants, setPlants] = useState([])
  const [locations, setLocations] = useState([])
  const [varieties, setVarieties] = useState([])
  const [loading, setLoading] = useState(true)
  const [voice, setVoice] = useState('idle') // idle | listening | error
  const [server, setServer] = useState(null)          // /api/search payload for the CURRENT query, or null
  const [serverState, setServerState] = useState('idle') // idle | loading | ok | error
  const inputRef = useRef(null)
  const voiceRef = useRef(null)
  const peekHeadingRef = useRef(null)
  const speechOk = isTranscriptionSupported()
  const peekId = params.get('peek')

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [pl, loc, vr] = await Promise.all([
          fetch('/api/plants').catch(() => []),
          fetch('/api/locations').catch(() => []),
          fetch('/api/varieties').catch(() => []),
        ])
        if (!alive) return
        setPlants(asArray(pl, 'plants'))
        setLocations(asArray(loc, 'locations'))
        setVarieties(asArray(vr, 'varieties'))
      } finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [fetch])

  // Full-page: autofocus the search box on mount. As an overlay: DEFER to the Sheet's focus-on-open
  // (it focuses the first non-close focusable = this input). If Search autofocused here, its child
  // effect would run before the Sheet's parent effect and the Sheet would capture THIS input as its
  // focus-restore target -> focus falls to <body> on close (§6, SC 2.4.3).
  useEffect(() => { if (!inOverlay) inputRef.current?.focus() }, [params, inOverlay])
  useEffect(() => () => { try { voiceRef.current?.cancel?.() } catch {} }, [])

  // §peek — move focus with the content swap. Deliberately NOT on mount (prev === undefined): at
  // mount the reasoning above still holds and the Sheet owns the target. Once the sheet is open its
  // [open] effect has already captured restoreRef, so moving focus between panes is safe in BOTH
  // surfaces — which matters on Android, where a swap with no focus move drops TalkBack's cursor
  // back to the top of the document with nothing announced.
  const prevPeekRef = useRef(undefined)
  useEffect(() => {
    const prev = prevPeekRef.current
    prevPeekRef.current = peekId
    if (prev === undefined || prev === peekId) return
    if (peekId) peekHeadingRef.current?.focus()
    else inputRef.current?.focus()
  }, [peekId])

  const stopVoice = useCallback(() => {
    try { voiceRef.current?.stop?.() } catch {}
    voiceRef.current = null
    setVoice('idle')
  }, [])
  const startVoice = useCallback(() => {
    if (!speechOk || voiceRef.current) return
    setVoice('listening')
    voiceRef.current = startLiveTranscription({
      languageCode: 'en-US',
      debugLabel: 'Search',   // BUG-VOICEDUPE-002 — names this surface in /admin/voice-debug
      onResult: ({ transcript }) => { if (transcript) setQ(transcript) },
      onError: () => { voiceRef.current = null; setVoice('error') },
      onEnd: ({ finalTranscript }) => { if (finalTranscript) setQ(finalTranscript); voiceRef.current = null; setVoice('idle') },
    })
  }, [speechOk])

  const query = norm(q).trim()

  // §peek — the ONE place a peek id is resolved. Keyed off the full `/api/plants` list rather than
  // the rendered result rows, so a planting that only surfaced through the SERVER slice (a
  // notes-column hit, whose row carries just id/name/status/project/snippet) still peeks with its
  // full wide row. Also the affordance gate: no Peek control is offered for an id this map cannot
  // answer, so the button never renders a dead tap.
  const plantIndex = useMemo(() => new Map(plants.map(p => [String(p.id), p])), [plants])
  const peekPlanting = peekId ? (plantIndex.get(String(peekId)) ?? null) : null
  const peekLocationName = useMemo(() => {
    if (!peekPlanting?.location_id) return null
    return locations.find(l => String(l.id) === String(peekPlanting.location_id))?.name ?? null
  }, [peekPlanting, locations])

  const searchUrl = useCallback(extra => {
    const sp = new URLSearchParams()
    const trimmed = q.trim()
    if (trimmed) sp.set('q', trimmed)
    if (extra) sp.set('peek', extra)
    const s = sp.toString()
    return s ? `/search?${s}` : '/search'
  }, [q])

  // PUSH, not replace — the one place this app's in-overlay content swap deliberately grows history,
  // because that pushed entry IS the thing system Back consumes to return to the results.
  // `peekPushed` marks it so the visible "Results" control can pop the SAME entry Back would; on a
  // cold deep-link there is no such entry and it replace-navigates instead (never a bare
  // navigate(-1), which at history index 0 is a silent no-op — see useOverlayDismiss).
  const openPeek = useCallback(id => {
    swap(searchUrl(id), { replace: false, state: { peekPushed: true } })
  }, [swap, searchUrl])
  const closePeek = useCallback(() => {
    if (location.state?.peekPushed) { navigate(-1); return }
    swap(searchUrl(null), { replace: true })
  }, [location.state, navigate, swap, searchUrl])

  // V4-SEARCH-002: debounced server search. Abort-on-supersede prevents a slow
  // stale response landing over a newer one; any failure degrades to client-only.
  useEffect(() => {
    if (query.length < SERVER_MIN_LEN) { setServer(null); setServerState('idle'); return }
    const ctl = new AbortController()
    const t = setTimeout(() => {
      setServerState('loading')
      fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: ctl.signal })
        .then(data => { if (!ctl.signal.aborted) { setServer(data); setServerState('ok') } })
        .catch(() => { if (!ctl.signal.aborted) { setServer(null); setServerState('error') } })
    }, SERVER_DEBOUNCE_MS)
    return () => { clearTimeout(t); ctl.abort() }
  }, [query, fetch])

  const results = useMemo(() => {
    if (!query) return { plants: [], locations: [], varieties: [] }
    const hit = s => norm(s).includes(query)
    return {
      plants: plants.filter(p => hit(p.name) || hit(p.variety_ref?.name) || hit(p.variety_ref?.group)).slice(0, 40),
      locations: locations.filter(l => hit(l.name)).slice(0, 40),
      varieties: varieties.filter(v => hit(v.name)).slice(0, 40),
    }
  }, [query, plants, locations, varieties])

  // Merge: server hits on the core three that the client filter missed (notes/care-notes
  // columns live server-side only). Client rows win; dedupe by id.
  const srv = (server && serverState === 'ok') ? { ...EMPTY_SERVER, ...(server.results ?? {}) } : EMPTY_SERVER
  const extraPlantings = useMemo(() => {
    const seen = new Set(results.plants.map(p => p.id))
    return srv.plantings.filter(r => !seen.has(r.id))
  }, [results.plants, srv.plantings])
  const extraLocations = useMemo(() => {
    const seen = new Set(results.locations.map(l => l.id))
    return srv.locations.filter(r => !seen.has(r.id))
  }, [results.locations, srv.locations])
  const extraVarieties = useMemo(() => {
    const seen = new Set(results.varieties.map(v => v.id))
    return srv.varieties.filter(r => !seen.has(r.id))
  }, [results.varieties, srv.varieties])

  const total = results.plants.length + results.locations.length + results.varieties.length
    + extraPlantings.length + extraLocations.length + extraVarieties.length
    // V4-PROJHIDE-001: the Projects results group is hidden below when projects aren't user-facing, so
    // it must not count toward `total` (else a project-only match suppresses the "No matches" state
    // while rendering nothing). Flag OFF keeps srv.projects.length in the sum (byte-identical).
    + (PROJECTS_HIDDEN ? 0 : srv.projects.length) + srv.events.length + srv.inventory.length + srv.photos.length

  const Row = ({ to, name, sub, onPeek, peekLabel }) => {
    const inner = (<><div style={{ flex: 1 }}><div style={nameStyle}>{name}</div>{sub && <div style={subStyle}>{sub}</div>}</div>{chev}</>)
    // No peek offered -> the historical single-element row, byte for byte. Every non-planting group
    // (locations, varieties, projects, events, inventory, photos) takes this branch untouched.
    if (!onPeek) return to ? <Link to={to} style={rowStyle}>{inner}</Link> : <div style={rowStyle}>{inner}</div>
    // With a peek: shell > link + control. The control is a SIBLING of the anchor, never nested
    // inside it — a <button> inside an <a> is invalid HTML and its activation is swallowed. The row's
    // own tap target keeps its existing destination, so the peek is purely additive (the dead-tap
    // repair of BUG-SEARCHDEADTAP-001 is not disturbed).
    return (
      <div style={peekShellStyle}>
        {to ? <Link to={to} style={peekRowLinkStyle}>{inner}</Link> : <div style={peekRowLinkStyle}>{inner}</div>}
        <button type="button" onClick={onPeek} aria-label={peekLabel} style={peekBtnStyle}>Peek</button>
      </div>
    )
  }

  const plantingRow = p => {
    // BUG-SEARCHDEADTAP-001: was `p.project_id && p.id ? /projects/${p.project_id}/plantings/${p.id} : null`.
    // A planting created by Snap/CaptureFlow carries NO project_id, so `to` fell to null and <Row>
    // rendered a plain <div> instead of a <Link> — the result appeared in search, looked tappable,
    // and did nothing. Measured on prod: 2 live plantings have a null project_id.
    // The un-scoped form is the CANONICAL route (App.jsx:199, V4-UNSCOPEDROUTES-001, which exists
    // precisely because "project-less plantings had no reachable detail page under the
    // /projects/:id/* forms"). The scoped form survives only as a redirect shim, so linking
    // straight to the canonical route also drops a redirect hop and is PROJHIDE-forward.
    const to = p.id ? `/plantings/${p.id}` : null
    // V4-PROJHIDE-001: drop the project_name fallback term from the planting subtitle when projects
    // aren't user-facing (variety/group/snippet still shown). Flag OFF keeps the exact prior chain.
    const sub = p.variety_ref?.name && p.variety_ref.name !== p.name ? p.variety_ref.name
      : (PROJECTS_HIDDEN
          ? (p.variety_ref?.group ?? p.snippet ?? null)
          : (p.variety_ref?.group ?? p.project_name ?? p.snippet ?? null))
    // §peek — offered only where plantIndex can actually answer the id (see its note above).
    const canPeek = p.id != null && plantIndex.has(String(p.id))
    return (
      <Row key={p.id} to={to} name={p.name || 'Planting'} sub={sub}
        onPeek={canPeek ? () => openPeek(String(p.id)) : undefined}
        peekLabel={canPeek ? `Peek at ${p.name || 'planting'}` : undefined} />
    )
  }

  // §peek — THE content swap. One sheet, one route, different pane: the search box and the result
  // groups are replaced rather than covered, which is what keeps this paned instead of stacked.
  // Returning early (rather than wrapping the list below in a conditional) leaves every line of the
  // results JSX untouched; the two outer wrappers are reproduced verbatim so the pane occupies
  // exactly the same box the list does. No hook is declared past this point.
  if (peekId) {
    return (
      <div style={{ minHeight: inOverlay ? 0 : 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
        <div style={{ maxWidth: 640, margin: '0 auto', padding: 16 }}>
          <button type="button" onClick={closePeek} style={backBtnStyle}>
            <span aria-hidden="true">{'‹'}</span> Back to results
          </button>
          {loading && <p style={{ ...subStyle, marginTop: 8 }}>Loading your garden&hellip;</p>}
          {!loading && !peekPlanting && (
            <p style={{ color: P.mid, fontSize: '0.9rem', marginTop: 8 }}>That planting isn&rsquo;t in your garden list any more.</p>
          )}
          {!loading && peekPlanting && (
            <PeekCard planting={peekPlanting} locationName={peekLocationName} headingRef={peekHeadingRef} />
          )}
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: inOverlay ? 0 : 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: 16 }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: P.white, border: `1px solid ${P.border}`, borderRadius: 22, height: 44, padding: '0 12px', position: 'sticky', top: 8, zIndex: 5, boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
          <MagnifierIcon />
          <input
            ref={inputRef}
            type="search"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search your whole garden"
            aria-label="Search your garden"
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: '0.95rem', color: P.dark, fontFamily: 'inherit' }}
          />
          {q && (
            <button type="button" onClick={() => { setQ(''); inputRef.current?.focus() }} aria-label="Clear search"
              style={{ border: 'none', background: 'transparent', color: P.light, fontSize: '1.1rem', cursor: 'pointer', lineHeight: 1, padding: 4 }}>{'×'}</button>
          )}
          {speechOk && (
            <button type="button" onClick={voice === 'listening' ? stopVoice : startVoice}
              aria-label={voice === 'listening' ? 'Stop voice search' : 'Voice search'}
              style={{ border: 'none', background: voice === 'listening' ? P.greenPale : 'transparent', borderRadius: '50%', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <MicIcon color={voice === 'listening' ? P.green : P.greenDeep} />
            </button>
          )}
        </div>

        {voice === 'listening' && <p style={{ ...subStyle, textAlign: 'center', margin: '10px 0 0' }}>Listening&hellip; speak your search.</p>}
        {voice === 'error' && <p style={{ ...subStyle, textAlign: 'center', margin: '10px 0 0' }}>Couldn&rsquo;t hear that &mdash; type your search instead.</p>}

        {loading && <p style={{ ...subStyle, textAlign: 'center', marginTop: 24 }}>Loading your garden&hellip;</p>}

        {!loading && !query && (
          <p style={{ color: P.mid, fontSize: '0.9rem', textAlign: 'center', marginTop: 28, lineHeight: 1.5 }}>
            Search everything in your garden &mdash; plantings, projects, locations,<br />
            varieties, events, inventory, and photo captions.
          </p>
        )}

        {!loading && query && total === 0 && serverState !== 'loading' && (
          <p style={{ color: P.mid, fontSize: '0.9rem', textAlign: 'center', marginTop: 28 }}>No matches for &ldquo;{q.trim()}&rdquo;.</p>
        )}

        {!loading && query && (results.plants.length > 0 || extraPlantings.length > 0) && (
          <>
            <div style={sectionHead}>Plantings</div>
            {results.plants.map(plantingRow)}
            {extraPlantings.map(plantingRow)}
          </>
        )}

        {!loading && query && (results.locations.length > 0 || extraLocations.length > 0) && (
          <>
            <div style={sectionHead}>Locations</div>
            {results.locations.map(l => <Row key={l.id} to={`/locations/${l.id}`} name={l.name} sub={null} />)}
            {extraLocations.map(l => <Row key={l.id} to={`/locations/${l.id}`} name={l.name} sub={l.type_label ?? null} />)}
          </>
        )}

        {!loading && query && (results.varieties.length > 0 || extraVarieties.length > 0) && (
          <>
            <div style={sectionHead}>Varieties</div>
            {results.varieties.map(v => (
              <div key={v.id} style={rowStyle}>
                <div style={{ flex: 1 }}><div style={nameStyle}>{v.name}</div>{(v.group || v.crop_type_slug) && <div style={subStyle}>{v.group || v.crop_type_slug}</div>}</div>
              </div>
            ))}
            {extraVarieties.map(v => (
              <div key={v.id} style={rowStyle}>
                <div style={{ flex: 1 }}><div style={nameStyle}>{v.name}</div>{(v.species || v.crop_type_slug) && <div style={subStyle}>{v.species || v.crop_type_slug}</div>}</div>
              </div>
            ))}
          </>
        )}

        {/* V4-PROJHIDE-001: the whole Projects results group is hidden when projects aren't user-facing
            (Plantings / Events / Inventory / Photos groups remain). Flag OFF renders it exactly as before. */}
        {!loading && query && !PROJECTS_HIDDEN && srv.projects.length > 0 && (
          <>
            <div style={sectionHead}>Projects</div>
            {srv.projects.map(pr => <Row key={pr.id} to={`/projects/${pr.id}`} name={pr.name} sub={pr.species || pr.snippet || pr.status || null} />)}
          </>
        )}

        {!loading && query && srv.events.length > 0 && (
          <>
            <div style={sectionHead}>Events</div>
            {srv.events.map(ev => (
              <Row key={ev.id}
                to={`/events/${ev.id}`}
                name={ev.title || ev.event_type}
                // V4-PROJHIDE-001: drop the project_name term from the event subtitle when projects
                // aren't user-facing (date + snippet remain). Flag OFF keeps project_name first.
                sub={[PROJECTS_HIDDEN ? null : ev.project_name, ev.event_date ? String(ev.event_date).slice(0, 10) : null, ev.snippet].filter(Boolean).join(' · ') || null} />
            ))}
          </>
        )}

        {!loading && query && srv.inventory.length > 0 && (
          <>
            <div style={sectionHead}>Inventory</div>
            {srv.inventory.map(it => <Row key={it.id} to={`/inventory/${it.id}`} name={it.name} sub={[it.category, it.location_text].filter(Boolean).join(' · ') || null} />)}
          </>
        )}

        {!loading && query && srv.photos.length > 0 && (
          <>
            <div style={sectionHead}>Photos</div>
            {srv.photos.map(ph => (
              <Row key={ph.id}
                // V4-UNSCOPEDROUTES-001: planting link no longer needs a project pair.
                // V4-PROJHIDE-001: a project-scoped photo (no planting) falls back to /photos, not the hidden project page. Flag OFF unchanged.
                to={ph.plant_id ? `/plantings/${ph.plant_id}` : (!PROJECTS_HIDDEN && ph.project_id ? `/projects/${ph.project_id}` : '/photos')}
                name={ph.caption} sub="Photo" />
            ))}
          </>
        )}

        {!loading && query && serverState === 'loading' && (
          <p style={{ ...subStyle, textAlign: 'center', marginTop: 16 }}>Searching the rest of your garden&hellip;</p>
        )}

      </div>
    </div>
  )
}

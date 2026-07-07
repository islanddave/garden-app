import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { BATCH_EVENT_TYPES, EVENT_TYPE_META, buildSecondaryGroups, PRIMARY_EVENT_TYPES } from '../lib/eventTypes.js'
import Icon from '../components/Icon.jsx'
import { ScopeChecklist } from '../components/forms'
import EventTypePicker, { EVENT_TYPES_UI } from '../components/forms/EventTypePicker.jsx'

// Bulk "Quick Log" (Unit A). Apply ONE event type to MANY plantings at once —
// one event per planting — without per-item tapping. Scope: All active / By Project /
// By Space. Server resolves the set (POST /api/events/batch); dry_run powers the
// server-accurate preview. Durable undo via /api/events/batches. V100: ambient, no interrupt.
//
// Lane D / Phase D (slice 2): the scope selector + 500-cap exclusion checklist live in
// the shared <ScopeChecklist> component (forms/). This page owns the scope/date/confirm/undo
// flow; the event-type selector is the SAME shared <EventTypePicker> tile grid Log Event uses
// (V4-EVENTSEL-003) — one component, visually identical on both surfaces.

// V4-EVENTSEL-002: the bulk selector is UNIFIED with Log One — it renders the SAME
// first-class order (PRIMARY_EVENT_TYPES from the canonical eventTypes.js), not a separate
// season-aware set. In bulk: `photo` is hidden (needs a file upload) and harvest/first_harvest
// are shown as chips but ROUTE to per-plant entry (they need a quantity); the remaining five
// are batch-submittable and fire the same server triggers (incl. flowering/fruit_set status
// advance) as the single-event path. Everything else batch-eligible is under "More event types".
const HARVEST_ROUTE_TYPES = new Set(['harvest', 'first_harvest'])

// The chips shown at the top of the bulk picker: the shared first-class set minus photo.
export const BULK_PRIMARY_VALUES = PRIMARY_EVENT_TYPES.filter(v => v !== 'photo')

// Of the shown chips, the ones actually submitted to /api/events/batch (harvest routes out).
export function bulkSubmittableValues() {
  return BULK_PRIMARY_VALUES.filter(v => !HARVEST_ROUTE_TYPES.has(v))
}
// Log Many's primary tiles = the shared first-class set minus photo (needs a file upload).
// Sourced from EVENT_TYPES_UI (not EVENT_TYPE_META) so the tile labels + icons are byte-identical
// to Log Event's grid. Stable module const → the picker's useMemo doesn't recompute per render.
const LOGMANY_PRIMARIES = EVENT_TYPES_UI.filter(t => t.value !== 'photo')

// Secondary event types — revealed via "More event types" expand. Every batch-eligible
// type NOT in the ACTIVE primary quick-picks, grouped by EVENT_TYPE_META category. We
// exclude only the currently-rendered primaries (NOT the union of both seasons) so that
// every batch type appears exactly once per render. Source of truth: BATCH_EVENT_TYPES +
// BATCH_EXCLUDED_TYPES in src/lib/eventTypes.js.
export function secondaryGroupsExcluding(primaryValues) {
  return buildSecondaryGroups(new Set(primaryValues), BATCH_EVENT_TYPES)
}

const SCOPE_KEY = 'quicklog.lastScope'

// V3-LOGMANY-001: GET /api/locations returns {locations,...} (object), not a bare array.
// Unwrap to the array LogMany/ScopeChecklist expect; tolerate either shape.
export function normalizeLocations(x) {
  return Array.isArray(x) ? x : (x?.locations ?? [])
}


function genKey() {
  try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID() } catch (e) {}
  return 'k-' + Date.now() + '-' + Math.random().toString(16).slice(2)
}

// Local-time YYYY-MM-DD for the back-date input's `max` (no future dates) and the
// "reset to today" comparison. toISOString() would shift behind-UTC offsets a day.
function todayYMD() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export default function LogMany() {
  const { fetch } = useApiFetch()
  const navigate = useNavigate()
  const [params] = useSearchParams()

  const [projects, setProjects]   = useState([])
  const [locations, setLocations] = useState([])
  const [ready, setReady]   = useState(false)
  const [loadErr, setLoadErr] = useState(null)

  const [eventType, setEventType] = useState('watering')
  // V3-EVENT-008 (V002 §5): bulk back-dating. Frost / bring-in events are often logged
  // the morning after. Empty string = "now" (server defaults to today, noon-anchored).
  const [eventDate, setEventDate] = useState('')
  const [scope, setScope]   = useState({ type: 'all' })
  const [selection, setSelection] = useState(null) // { committedCount, excludedIds } from ScopeChecklist
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState(null)       // { batch_id, count }
  const [error, setError]   = useState(null)
  const idemRef = useRef(null)

  // V4-EVENTSEL-003: Log Many renders the SAME <EventTypePicker> tile grid as Log Event (below),
  // so the two selectors are visually identical. harvest/first_harvest tiles route to per-plant
  // entry (need a quantity); photo is hidden in bulk (absent from LOGMANY_PRIMARIES); everything
  // else selects for the batch apply.
  function goPerPlant(type) {
    navigate(`/log?event_type=${encodeURIComponent(type)}`)
  }
  function handlePick(v) {
    if (HARVEST_ROUTE_TYPES.has(v)) goPerPlant(v)
    else setEventType(v)
  }

  // Load projects + locations; restore last scope (validated against live data); seed from ?project_id / ?location_id.
  useEffect(() => {
    let on = true
    Promise.all([fetch('/api/projects'), fetch('/api/locations')])
      .then(([proj, locs]) => {
        if (!on) return
        // V3-ARCHIVE-001: archived projects must not appear in the Log Many scope picker.
        proj = (proj ?? []).filter(pr => !pr.archived_at); locs = normalizeLocations(locs)
        setProjects(proj); setLocations(locs)
        const seedProject = params.get('project_id')
        const seedLocation = params.get('location_id')
        if (seedProject && proj.some(p => p.id === seedProject)) setScope({ type: 'project', project_id: seedProject })
        else if (seedLocation && locs.some(l => l.id === seedLocation)) setScope({ type: 'space', location_id: seedLocation })
        else {
          try {
            const saved = JSON.parse(localStorage.getItem(SCOPE_KEY) || 'null')
            if (saved && saved.type === 'all') setScope(saved)
            else if (saved && saved.type === 'project' && proj.some(p => p.id === saved.project_id)) setScope(saved)
            else if (saved && saved.type === 'space' && locs.some(l => l.id === saved.location_id)) setScope(saved)
          } catch (e) {}
        }
        setReady(true)
      })
      .catch(err => { if (on) { setLoadErr(err.message); setReady(true) } })
    return () => { on = false }
  }, [fetch, params])

  // Server dry-run for ScopeChecklist. Stable (deps: fetch) — eventType/eventDate are
  // passed as call args so a vocabulary change retriggers the child's effect, not this fn.
  // `signal` flows to native fetch (api.js spreads options) → real request cancellation.
  const runDryRun = useCallback(({ scope, eventType, eventDate, signal }) =>
    fetch('/api/events/batch', {
      method: 'POST',
      body: JSON.stringify({ dry_run: true, event_type: eventType, scope, ...(eventDate ? { event_date: eventDate } : {}) }),
      signal,
    }), [fetch])

  const onSelectionChange = useCallback((sel) => setSelection(sel), [])

  const evMeta = {
    value: eventType,
    label: EVENT_TYPE_META[eventType]?.label ?? eventType,
    emoji: EVENT_TYPE_META[eventType]?.emoji ?? '📌',
  }
  const verbLabel = evMeta.label.toLowerCase()
  const committedCount = selection?.committedCount ?? 0
  const scopeLabel = scope.type === 'all' ? 'all active plantings'
    : scope.type === 'project' ? (projects.find(p => p.id === scope.project_id)?.name ?? 'project')
    : (locations.find(l => l.id === scope.location_id)?.name ?? 'space')

  async function confirm() {
    if (committedCount === 0 || saving) return
    if (!idemRef.current) idemRef.current = genKey()
    setSaving(true); setError(null)
    try {
      const r = await fetch('/api/events/batch', { method: 'POST', body: JSON.stringify({
        idempotency_key: idemRef.current, event_type: eventType, scope,
        exclude_plant_ids: selection?.excludedIds ?? [],
        ...(eventDate ? { event_date: eventDate } : {}),
      }) })
      try { localStorage.setItem(SCOPE_KEY, JSON.stringify(scope)) } catch (e) {}
      // MVP-Critter — critters are awarded SERVER-SIDE by the events Lambda batch handler
      // (Phase B++ refactor 2026-05-30). V3-CRITTER-002: wake CritterArrivalController so the
      // Stage-1 flash fires on this page without a route change. The controller's effect dep
      // includes location.state — pushing a new state object (same pathname, replace:true)
      // triggers a re-poll. Critter is in DB before this resolves (Lambda awards inline).
      setResult(r)
      navigate('.', { state: { critterCheck: Date.now() }, replace: true })
    } catch (err) { setError(err.message) }
    setSaving(false)
  }

  async function undo() {
    if (!result) return
    const id = result.batch_id
    try {
      await fetch('/api/events/batch/' + id, { method: 'DELETE' })
      idemRef.current = null
      setResult(null); setError(null)   // ScopeChecklist remounts → fresh preview
    } catch (err) { setError('Undo failed: ' + err.message) }
  }

  function logMore() { idemRef.current = null; setResult(null); setError(null) }

  if (!ready) return <Shell><Spinner /></Shell>
  if (loadErr) return <Shell><ErrMsg msg={loadErr} /></Shell>

  // ── Result (ambient confirmation + durable undo) ──
  if (result) {
    return (
      <Shell>
        <Header />
        <div style={{ backgroundColor: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: 10, padding: 20, textAlign: 'center' }}>
          <div style={{ marginBottom: 6, color: P.green }}><Icon name={`event.${evMeta.value}`} size={32} decorative /></div>
          <p style={{ margin: '0 0 4px', fontWeight: 700, color: P.green, fontSize: '1.05rem' }} role="status">
            ✓ {result.count} {result.count === 1 ? 'planting' : 'plantings'} {verbLabel}
          </p>
          <p style={{ margin: '0 0 16px', color: P.mid, fontSize: '0.85rem' }}>in {scopeLabel}</p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button type="button" onClick={undo} style={btnGhost}>Undo</button>
            <button type="button" onClick={logMore} style={btnGhost}>Log more</button>
            <button type="button" onClick={() => navigate('/garden')} style={btnPrimary}>Done</button>
          </div>
        </div>
        {error && <ErrInline msg={error} />}
      </Shell>
    )
  }

  // ── Picker + scope/preview + confirm ──
  return (
    <Shell>
      <Header />

      <Section label="What happened?">
        {/* V4-EVENTSEL-003: the SAME tile-grid selector as Log Event (EventNew). primaries =
            shared first-class set minus photo; available = BATCH_EVENT_TYPES scopes the "More"
            panel to batch-eligible types; handlePick routes harvest to per-plant, else selects. */}
        <EventTypePicker
          primaries={LOGMANY_PRIMARIES}
          available={BATCH_EVENT_TYPES}
          value={eventType}
          onChange={handlePick}
        />
      </Section>

      <Section label="When?">
        {/* V3-EVENT-008 (V002 §5): back-dating for bulk frost / bring-in events logged the
            morning after. Defaults to today (empty = server "now"); future dates blocked. */}
        <input
          type="date"
          value={eventDate}
          max={todayYMD()}
          onChange={e => setEventDate(e.target.value)}
          aria-label="Event date (leave as today, or back-date)"
          style={selectStyle}
        />
        {eventDate && eventDate !== todayYMD() && (
          <button type="button" onClick={() => setEventDate('')} style={{ ...linkBtn, marginTop: 8 }}>
            Reset to today
          </button>
        )}
      </Section>

      <ScopeChecklist
        scope={scope}
        onScopeChange={setScope}
        projects={projects}
        locations={locations}
        eventType={eventType}
        eventDate={eventDate}
        verbLabel={verbLabel}
        runDryRun={runDryRun}
        onSelectionChange={onSelectionChange}
      />

      {error && <ErrInline msg={error} />}

      <button type="button" onClick={confirm} disabled={saving || committedCount === 0}
        style={{ ...btnPrimary, width: '100%', minHeight: 48, opacity: (saving || committedCount === 0) ? 0.5 : 1,
          cursor: (saving || committedCount === 0) ? 'default' : 'pointer' }}>
        {saving ? 'Logging…' : `Log ${verbLabel} on ${committedCount}`}
      </button>
    </Shell>
  )
}

function Header() {
  return (
    <div style={{ marginBottom: 24 }}>
      <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Log many</h1>
      {/* V4-EVENTSEL-004: cross-link matches Log Event's exactly — same ghost style, sitting
          UNDERNEATH the title (Log Event's pattern), not right-floated. */}
      <div style={{ marginTop: 8 }}>
        <Link to="/log" style={crossLinkStyle}>Log one →</Link>
      </div>
    </div>
  )
}
function Section({ label, children }) {
  // V4-EVENTSEL-004: card styling matches Log Event's Section (white bordered box + uppercase
  // label) so the event selector looks IDENTICAL on both surfaces (neat box, "More" contained).
  return (
    <div style={{ marginBottom: 16, backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '16px 18px' }}>
      {label && <label style={{ display: 'block', fontSize: '0.77rem', fontWeight: 700, color: P.mid, marginBottom: 10, letterSpacing: '0.4px', textTransform: 'uppercase' }}>{label}</label>}
      {children}
    </div>
  )
}
function Shell({ children }) {
  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '28px 20px 80px' }}>{children}</div>
    </div>
  )
}
function Spinner() { return <div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div> }
function ErrMsg({ msg }) { return <div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{msg}</div> }
function ErrInline({ msg }) { return <p role="alert" style={{ color: P.terra, fontSize: '0.85rem', margin: '0 0 12px' }}>{msg}</p> }

const btnPrimary = { backgroundColor: P.green, color: P.white, border: 'none', borderRadius: 8, padding: '11px 18px', fontSize: '0.9rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }
const btnGhost = { backgroundColor: P.white, color: P.green, border: `1px solid ${P.greenLight}`, borderRadius: 8, padding: '10px 16px', fontSize: '0.88rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }
// V4-EVENTSEL-004: byte-identical to Log Event's cross-link button (EventNew.jsx) so the two match exactly.
const crossLinkStyle = { display: 'inline-block', marginTop: 4, backgroundColor: P.white, color: P.green, border: `1px solid ${P.greenLight}`, borderRadius: 8, padding: '8px 14px', fontSize: '0.85rem', fontWeight: 600, textDecoration: 'none' }
const linkBtn = { background: 'none', border: 'none', color: P.green, fontSize: '0.83rem', fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: 'inherit', textDecoration: 'underline' }
const selectStyle = { width: '100%', minHeight: 44, padding: '8px 12px', borderRadius: 8, border: `1px solid ${P.border}`, fontSize: '0.9rem', fontFamily: 'inherit', backgroundColor: P.white, color: P.dark }

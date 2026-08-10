import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useOverlaySwap, OverlaySwapLink, useOverlayDismiss, useOverlayBackground } from '../context/OverlayContext.jsx'
import { readDraft, writeDraft, clearDraft } from '../lib/draftStash.js'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { BATCH_EVENT_TYPES, EVENT_TYPE_META, buildSecondaryGroups, PRIMARY_EVENT_TYPES } from '../lib/eventTypes.js'
import Icon from '../components/Icon.jsx'
import { ScopeChecklist } from '../components/forms'
import Spinner from '../components/forms/Spinner.jsx'
import EventTypePicker, { EVENT_TYPES_UI } from '../components/forms/EventTypePicker.jsx'

// Bulk "Quick Log" (Unit A). Apply ONE event type to MANY plantings at once —
// one event per planting — without per-item tapping. Scope: All active / By Project /
// By Zone. Server resolves the set (POST /api/events/batch); dry_run powers the
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
const EVENT_TYPE_KEY = 'quicklog.lastEventType'

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

const DRAFT_KEY = 'logmany'

export default function LogMany() {
  const { fetch } = useApiFetch()
  const navigate = useNavigate()
  const swap = useOverlaySwap()               // in-overlay cross-nav that preserves the background (§4)
  const dismiss = useOverlayDismiss()          // §4 dismiss — never bare navigate(-1)
  const background = useOverlayBackground()     // preserved through the post-batch critterCheck push
  const [params] = useSearchParams()

  const [projects, setProjects]   = useState([])
  const [locations, setLocations] = useState([])
  const [ready, setReady]   = useState(false)
  const [loadErr, setLoadErr] = useState(null)

  const [eventType, setEventType] = useState(() => {
    try {
      const saved = localStorage.getItem(EVENT_TYPE_KEY)
      if (saved && BATCH_EVENT_TYPES.includes(saved)) return saved
    } catch (e) {}
    return 'watering'
  })
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
    // Cross-nav to Log One INSIDE the overlay — swap keeps the underlying page as background so
    // dismiss still returns to it (using useOverlayNavigate here would wrongly set bg to /log/many).
    swap(`/log?event_type=${encodeURIComponent(type)}`)
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
          // §4 draft stash: a dismissed-while-dirty form resumes here (validated against live data).
          // Takes priority over the localStorage lastScope memory; only with no seed deep-link (a
          // bare "Log many" tap), so a deep-link intent still wins.
          // V4-DRAFTFULLPAGE-001 (c): BOTH surfaces, not overlay-only. Full-page /log/many is reached
          // by deep link, bookmark and notification; there the stash was inert, so an exit lost the
          // event type, date, scope AND the persisted idemKey that makes a retry idempotent. Mirrors
          // the (a) change already shipped for EventNew — same rationale: no router blocker is
          // possible (useBlocker needs a data router, App uses declarative BrowserRouter), and
          // persistence beats blocking on mobile.
          const draft = readDraft(DRAFT_KEY)
          if (draft) {
            if (draft.eventType && BATCH_EVENT_TYPES.includes(draft.eventType)) setEventType(draft.eventType)
            if (typeof draft.eventDate === 'string') setEventDate(draft.eventDate)
            const ds = draft.scope
            if (ds && (ds.type === 'all'
              || (ds.type === 'project' && proj.some(p => p.id === ds.project_id))
              || (ds.type === 'space' && locs.some(l => l.id === ds.location_id)))) setScope(ds)
            if (typeof draft.idemKey === 'string') idemRef.current = draft.idemKey   // idempotent retry across dismiss
          } else {
            try {
              const saved = JSON.parse(localStorage.getItem(SCOPE_KEY) || 'null')
              if (saved && saved.type === 'all') setScope(saved)
              else if (saved && saved.type === 'project' && proj.some(p => p.id === saved.project_id)) setScope(saved)
              else if (saved && saved.type === 'space' && locs.some(l => l.id === saved.location_id)) setScope(saved)
            } catch (e) {}
          }
        }
        setReady(true)
      })
      .catch(err => { if (on) { setLoadErr(err.message); setReady(true) } })
    return () => { on = false }
  }, [fetch, params])

  // §4 draft stash: persist the in-progress form while dirty (BOTH surfaces, V4-DRAFTFULLPAGE-001 (c)),
  // so a dismiss OR a full-page exit preserves it; cleared on a successful confirm/undo below.
  // Never persists the pristine default or the
  // post-result screen (result set = already written to DB, not a resumable draft).
  // Gate on `!ready`: the persist effect runs synchronously on mount, BEFORE the async load's
  // readDraft (which resolves in a later microtask inside the fetch .then). Without the gate, a user
  // whose remembered eventType is non-watering trips `dirty` on mount and writes a pristine draft
  // that the load then reads back — shadowing the localStorage `lastScope` restore (silent reset to
  // "All plantings"). Deferring until ready (load resolved) makes readDraft see null and honors the
  // lastScope memory; from then on it persists real edits normally.
  useEffect(() => {
    if (result || !ready) return
    const dirty = eventType !== 'watering' || !!eventDate || scope.type !== 'all'
    if (dirty) writeDraft(DRAFT_KEY, { eventType, eventDate, scope, idemKey: idemRef.current })
  }, [result, ready, eventType, eventDate, scope])

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
    : (locations.find(l => l.id === scope.location_id)?.name ?? 'zone')

  async function confirm() {
    if (committedCount === 0 || saving) return
    if (!idemRef.current) idemRef.current = genKey()
    // §4: persist the idempotency key immediately (a ref change won't re-run the persist effect). If
    // the POST fails and the user dismisses OR exits, re-opening restores THIS key so the retry is
    // idempotent. V4-DRAFTFULLPAGE-001 (c): both surfaces — this is the byte whose loss on the
    // full page turned a failed batch into a non-idempotent retry.
    writeDraft(DRAFT_KEY, { eventType, eventDate, scope, idemKey: idemRef.current })
    setSaving(true); setError(null)
    try {
      const r = await fetch('/api/events/batch', { method: 'POST', body: JSON.stringify({
        idempotency_key: idemRef.current, event_type: eventType, scope,
        exclude_plant_ids: selection?.excludedIds ?? [],
        ...(eventDate ? { event_date: eventDate } : {}),
      }) })
      try { localStorage.setItem(SCOPE_KEY, JSON.stringify(scope)) } catch (e) {}
      try { localStorage.setItem(EVENT_TYPE_KEY, eventType) } catch (e) {}
      // MVP-Critter — critters are awarded SERVER-SIDE by the events Lambda batch handler
      // (Phase B++ refactor 2026-05-30). V3-CRITTER-002: wake CritterArrivalController so the
      // Stage-1 flash fires on this page without a route change. The controller's effect dep
      // includes location.state — pushing a new state object (same pathname, replace:true)
      // triggers a re-poll. Critter is in DB before this resolves (Lambda awards inline).
      clearDraft(DRAFT_KEY)   // batch is in the DB — no longer a resumable draft
      setResult(r)
      // §4 FIX: spread the existing state so the carried `background` survives this same-path push.
      // The bug: replacing state wholesale destroyed `background` → the overlay unmounted → `result`
      // was lost → the success screen + Undo became permanently unreachable for a batch already
      // written to the DB. Preserving `background` keeps the overlay mounted on the result screen.
      navigate('.', { state: { ...(background ? { background } : {}), critterCheck: Date.now() }, replace: true })
    } catch (err) { setError(err.message) }
    setSaving(false)
  }

  async function undo() {
    if (!result) return
    const id = result.batch_id
    try {
      await fetch('/api/events/batch/' + id, { method: 'DELETE' })
      idemRef.current = null
      clearDraft(DRAFT_KEY)
      setResult(null); setError(null)   // ScopeChecklist remounts → fresh preview
    } catch (err) { setError('Undo failed: ' + err.message) }
  }

  function logMore() { idemRef.current = null; clearDraft(DRAFT_KEY); setResult(null); setError(null) }

  if (!ready) return <Shell><Spinner block /></Shell>
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
            {/* §4 FIX: dismiss to the background (the page the user opened this from), not a hard
                navigate('/garden') that dumped them on Garden. Full-page fallback = /today. */}
            <button type="button" onClick={dismiss} style={btnPrimary}>Done</button>
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
        {/* V4-LOGMANYHONEST-001: say it BEFORE the tap, not after. Harvest tiles render here but
            route out to per-plant entry (goPerPlant), because a harvest needs a quantity and unit
            and the batch body cannot carry per-planting values. Un-announced, that reads as a
            mis-tap: the user deliberately chose the bulk surface and silently landed on a
            single-event form with nothing to attribute it to. Preventing the surprise beats
            explaining it afterwards, so this is a standing hint rather than a post-hoc notice.
            Remove this line if/when harvest ever becomes batch-submittable. */}
        <p data-testid="logmany-harvest-hint" style={{ margin: '10px 2px 0', fontSize: '0.78rem', color: P.light, lineHeight: 1.45 }}>
          Harvests are logged one at a time — each one needs its own quantity.
        </p>
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
        <OverlaySwapLink to="/log" style={crossLinkStyle}>Log one →</OverlaySwapLink>
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
function ErrMsg({ msg }) { return <div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{msg}</div> }
function ErrInline({ msg }) { return <p role="alert" style={{ color: P.terra, fontSize: '0.85rem', margin: '0 0 12px' }}>{msg}</p> }

const btnPrimary = { backgroundColor: P.green, color: P.white, border: 'none', borderRadius: 8, padding: '11px 18px', fontSize: '0.9rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }
const btnGhost = { backgroundColor: P.white, color: P.green, border: `1px solid ${P.greenLight}`, borderRadius: 8, padding: '10px 16px', fontSize: '0.88rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }
// V4-EVENTSEL-004: byte-identical to Log Event's cross-link button (EventNew.jsx) so the two match exactly.
const crossLinkStyle = { display: 'inline-block', marginTop: 4, backgroundColor: P.white, color: P.green, border: `1px solid ${P.greenLight}`, borderRadius: 8, padding: '8px 14px', fontSize: '0.85rem', fontWeight: 600, textDecoration: 'none' }
const linkBtn = { background: 'none', border: 'none', color: P.green, fontSize: '0.83rem', fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: 'inherit', textDecoration: 'underline' }
const selectStyle = { width: '100%', minHeight: 44, padding: '8px 12px', borderRadius: 8, border: `1px solid ${P.border}`, fontSize: '0.9rem', fontFamily: 'inherit', backgroundColor: P.white, color: P.dark }

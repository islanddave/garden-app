import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { BATCH_EVENT_TYPES, EVENT_TYPE_META, buildSecondaryGroups } from '../lib/eventTypes.js'
import { ScopeChecklist, SelectChip } from '../components/forms'

// Bulk "Quick Log" (Unit A). Apply ONE event type to MANY plantings at once —
// one event per planting — without per-item tapping. Scope: All active / By Project /
// By Space. Server resolves the set (POST /api/events/batch); dry_run powers the
// server-accurate preview. Durable undo via /api/events/batches. V100: ambient, no interrupt.
//
// Lane D / Phase D (slice 2): the scope selector + 500-cap exclusion checklist live in
// the shared <ScopeChecklist> component (forms/). This page owns the event-type picker
// (season-aware bulk primaries — distinct from EventNew's EventTypePicker grid), the
// date, and the confirm/undo/result flow. The two pickers share the SelectChip grammar.

// V3-EVENT-008: vocabulary derives from the canonical src/lib/eventTypes.js. The 4 primary
// quick-picks stay as a page-level UX choice (most common bulk ops above the fold);
// everything else batch-eligible is grouped under "More event types" via buildSecondaryGroups().

// Primary quick-picks — the 4 most common bulk operations stay above the fold.
// V3-EVENT-008 (V002 §5): SEASON-AWARE / frequency-weighted. In cold-protection season
// (Conway MA frost risk ~Oct–Apr) the most frequent bulk action is moving plantings in/out,
// so brought_inside + brought_outside replace the two lowest-frequency warm-season picks
// (observation, pruning). Year-round staples watering + fertilizing always stay. UX
// weighting only — NOT a work gate (no date gates garden work; see CLAUDE.md).
const WARM_SEASON_PRIMARIES = ['watering', 'fertilizing', 'observation', 'pruning']
const COLD_SEASON_PRIMARIES = ['watering', 'fertilizing', 'brought_inside', 'brought_outside']

// Cold-protection months (0-indexed): Jan,Feb,Mar,Apr (0-3) + Oct,Nov,Dec (9-11).
// Injectable `month` keeps this pure + testable.
export function coldProtectionSeason(month = new Date().getMonth()) {
  return month <= 3 || month >= 9
}
export function primaryValuesForSeason(cold = coldProtectionSeason()) {
  return cold ? COLD_SEASON_PRIMARIES : WARM_SEASON_PRIMARIES
}
function toChips(values) {
  return values.map(v => ({
    value: v,
    label: EVENT_TYPE_META[v]?.label ?? v,
    emoji: EVENT_TYPE_META[v]?.emoji ?? '📌',
  }))
}

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
  const [showMoreTypes, setShowMoreTypes] = useState(false)
  // V3-EVENT-008 (V002 §5): bulk back-dating. Frost / bring-in events are often logged
  // the morning after. Empty string = "now" (server defaults to today, noon-anchored).
  const [eventDate, setEventDate] = useState('')
  const [scope, setScope]   = useState({ type: 'all' })
  const [selection, setSelection] = useState(null) // { committedCount, excludedIds } from ScopeChecklist
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState(null)       // { batch_id, count }
  const [error, setError]   = useState(null)
  const idemRef = useRef(null)

  // V3-EVENT-008: season-aware primaries + derived secondary groups (per-render — cheap,
  // keeps the seasonal selection live without remount). primaries are the quick-pick chips.
  const primaries = toChips(primaryValuesForSeason())
  const primaryValueSet = new Set(primaries.map(t => t.value))
  const secondaryGroups = secondaryGroupsExcluding(primaries.map(t => t.value))
  const allTypes = [...primaries, ...secondaryGroups.flatMap(([, types]) => types)]

  // If the user reopens the page with a previously-selected secondary type saved in
  // eventType, keep the More panel open so their selection stays visible.
  useEffect(() => {
    if (!primaryValueSet.has(eventType)) setShowMoreTypes(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventType])

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

  const evMeta = allTypes.find(t => t.value === eventType) || primaries[0]
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
          <div style={{ fontSize: '2rem', marginBottom: 6 }} aria-hidden="true">{evMeta.emoji}</div>
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

      <Section>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {primaries.map(t => (
            <SelectChip key={t.value} active={eventType === t.value} onClick={() => setEventType(t.value)}>
              <span aria-hidden="true">{t.emoji}</span> {t.label}
            </SelectChip>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setShowMoreTypes(s => !s)}
          aria-expanded={showMoreTypes}
          style={{
            marginTop: 12, background: 'none', border: 'none',
            cursor: 'pointer', color: P.green, fontSize: '0.82rem',
            fontWeight: 600, padding: '4px 0',
            display: 'flex', alignItems: 'center', gap: 5,
          }}
        >
          <span aria-hidden="true">{showMoreTypes ? '▾' : '▸'}</span>
          <span>More event types</span>
        </button>

        {showMoreTypes && (
          <div style={{ marginTop: 8 }}>
            {secondaryGroups.map(([category, types]) => (
              <div key={category} style={{ marginBottom: 14 }}>
                <div style={{
                  fontSize: '0.7rem', fontWeight: 700, color: P.light,
                  letterSpacing: '0.4px', textTransform: 'uppercase',
                  marginBottom: 8,
                }}>
                  {category}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {types.map(t => (
                    <SelectChip key={t.value} active={eventType === t.value} onClick={() => setEventType(t.value)}>
                      <span aria-hidden="true">{t.emoji}</span> {t.label}
                    </SelectChip>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section>
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
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
      <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Log many</h1>
      {/* V3-LOGBTN-001: themed ghost button, not a raw text link. */}
      <Link to="/log" style={{ ...btnGhost, textDecoration: 'none', display: 'inline-block' }}>Log one →</Link>
    </div>
  )
}
function Section({ label, children }) {
  // V3-LOGMANY copy strip: label optional — page is buttons-only, no helper prompts.
  return (
    <div style={{ marginBottom: 16 }}>
      {label && <p style={{ margin: '0 0 8px', fontWeight: 600, color: P.dark, fontSize: '0.9rem' }}>{label}</p>}
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
const linkBtn = { background: 'none', border: 'none', color: P.green, fontSize: '0.83rem', fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: 'inherit', textDecoration: 'underline' }
const selectStyle = { width: '100%', minHeight: 44, padding: '8px 12px', borderRadius: 8, border: `1px solid ${P.border}`, fontSize: '0.9rem', fontFamily: 'inherit', backgroundColor: P.white, color: P.dark }

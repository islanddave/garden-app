import React, { useState, useEffect, useCallback, useRef } from 'react'
import ProjectOptions from '../components/ProjectOptions.jsx'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { BATCH_EVENT_TYPES, EVENT_TYPE_META, buildSecondaryGroups } from '../lib/eventTypes.js'

// Bulk "Quick Log" (Unit A). Apply ONE event type to MANY plantings at once —
// one event per planting — without per-item tapping. Scope: All active / By Project /
// By Space. Server resolves the set (POST /api/events/batch); dry_run powers the
// server-accurate preview. Durable undo via /api/events/batches. V100: ambient, no interrupt.

// V3-EVENT-008: vocabulary now derives from the canonical src/lib/eventTypes.js
// (single source of truth). The local hand-maintained copy (which surfaced only 18 of
// the 30 batch-valid types) is gone — ALL BATCH_EVENT_TYPES are now reachable here, and
// the labels/emojis come from the shared EVENT_TYPE_META. The 4 primary quick-picks stay
// as a page-level UX choice (most common bulk ops above the fold); everything else batch-
// eligible is grouped under "More event types" via buildSecondaryGroups().

// Primary quick-picks — the 4 most common bulk operations stay above the fold.
// V3-EVENT-008 (V002 §5): SEASON-AWARE / frequency-weighted. In cold-protection
// season (Conway MA growing-zone reality: frost risk runs ~Oct–Apr) the single most
// frequent bulk action this garden performs is moving plantings in/out, so
// brought_inside + brought_outside replace the two lowest-frequency warm-season picks
// (observation, pruning). Year-round staples watering + fertilizing always stay.
// All primaries are asserted batch-eligible by the LogMany render test. This is UX
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
// every batch type appears exactly once per render: a value that is a primary THIS season
// is a chip above; a value that is a primary in the OTHER season (e.g. observation/pruning
// in cold season) drops back into "More" rather than vanishing. Excluded from batch
// entirely (never surfaced here): harvest/first_harvest (need quantity), photo (needs a
// file), and the four propagation/single-plant HS-1 types divided/cutting_taken/
// hand_pollinated/fruit_set. Source of truth: BATCH_EVENT_TYPES + BATCH_EXCLUDED_TYPES
// in src/lib/eventTypes.js.
export function secondaryGroupsExcluding(primaryValues) {
  return buildSecondaryGroups(new Set(primaryValues), BATCH_EVENT_TYPES)
}

const SCOPE_KEY = 'quicklog.lastScope'
// FIX-3: per-DEVICE default selection (true=start all selected [Dave default], false=start none [Jen]).
// Device-local expedient; server-side per-user migration tracked as V4-LOGMANY-001 (Cross-Device State Principle).
const DEFAULT_SEL_KEY = 'quicklog.defaultAllSelected'

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
  // the morning after they happened, so the batch must accept a back-dated event_date.
  // Empty string = "now" (server defaults to today, noon-anchored). YYYY-MM-DD only.
  const [eventDate, setEventDate] = useState('')
  const [scope, setScope]   = useState({ type: 'all' })
  const [preview, setPreview]   = useState(null)   // { count, capped, plantings:[{id,name}] }
  const [excluded, setExcluded] = useState(() => new Set())
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState(null)       // { batch_id, count }
  const [error, setError]   = useState(null)
  const [showList, setShowList] = useState(false)
  const [defaultAllSelected, setDefaultAllSelected] = useState(() => {
    try { const v = localStorage.getItem(DEFAULT_SEL_KEY); return v === null ? true : v === '1' } catch (e) { return true }
  })
  const idemRef = useRef(null)

  // V3-EVENT-008: season-aware primaries + derived secondary groups (per-render —
  // cheap, and keeps the seasonal selection live without remount). primaries are the
  // quick-pick chips; secondaryGroups holds everything else batch-eligible.
  const primaries = toChips(primaryValuesForSeason())
  const primaryValueSet = new Set(primaries.map(t => t.value))
  const secondaryGroups = secondaryGroupsExcluding(primaries.map(t => t.value))
  const allTypes = [...primaries, ...secondaryGroups.flatMap(([, types]) => types)]

  // If the user reopens the page with a previously-selected secondary type
  // saved in eventType (e.g. via "Log more"), keep the More panel open so
  // their selection stays visible.
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
        proj = proj ?? []; locs = locs ?? []
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

  // Server-accurate preview on scope / event-type change (skip once a batch is committed).
  useEffect(() => {
    if (!ready || result) return
    let on = true
    setPreviewing(true); setError(null); setExcluded(new Set())
    fetch('/api/events/batch', { method: 'POST', body: JSON.stringify({ dry_run: true, event_type: eventType, scope, ...(eventDate ? { event_date: eventDate } : {}) }) })
      .then(r => { if (on) {
        setPreview(r); setPreviewing(false)
        setExcluded(defaultAllSelected ? new Set() : new Set((r.plantings || []).map(pl => pl.id)))
      } })
      .catch(err => { if (on) { setError(err.message); setPreview(null); setPreviewing(false) } })
    return () => { on = false }
  }, [ready, scope, eventType, eventDate, fetch, result])

  const toggleExclude = useCallback((id) => {
    setExcluded(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }, [])

  // FIX-3: flip the per-device default and re-apply to the current preview immediately.
  const applyDefaultSel = useCallback((on) => {
    setDefaultAllSelected(on)
    try { localStorage.setItem(DEFAULT_SEL_KEY, on ? '1' : '0') } catch (e) {}
    setExcluded(on ? new Set() : new Set((preview?.plantings || []).map(pl => pl.id)))
  }, [preview])

  const evMeta = allTypes.find(t => t.value === eventType) || primaries[0]
  const verbLabel = evMeta.label.toLowerCase()
  const committed = preview ? preview.plantings.filter(p => !excluded.has(p.id)) : []
  const scopeLabel = scope.type === 'all' ? 'all active plantings'
    : scope.type === 'project' ? (projects.find(p => p.id === scope.project_id)?.name ?? 'project')
    : (locations.find(l => l.id === scope.location_id)?.name ?? 'space')

  async function confirm() {
    if (committed.length === 0 || saving) return
    if (!idemRef.current) idemRef.current = genKey()
    setSaving(true); setError(null)
    try {
      const r = await fetch('/api/events/batch', { method: 'POST', body: JSON.stringify({
        idempotency_key: idemRef.current, event_type: eventType, scope,
        exclude_plant_ids: [...excluded],
        ...(eventDate ? { event_date: eventDate } : {}),
      }) })
      try { localStorage.setItem(SCOPE_KEY, JSON.stringify(scope)) } catch (e) {}
      // MVP-Critter — critters are awarded SERVER-SIDE by the events Lambda batch handler
      // (Phase B++ refactor 2026-05-30). No client-side fan-out needed; Dashboard backfill
      // surfaces the freshest via fetchActiveCritters.
      setResult(r)
    } catch (err) { setError(err.message) }
    setSaving(false)
  }

  async function undo() {
    if (!result) return
    const id = result.batch_id
    try {
      await fetch('/api/events/batch/' + id, { method: 'DELETE' })
      idemRef.current = null
      setResult(null); setError(null)
      setScope(s => ({ ...s }))   // retrigger preview
    } catch (err) { setError('Undo failed: ' + err.message) }
  }

  function logMore() { idemRef.current = null; setResult(null); setError(null); setScope(s => ({ ...s })) }

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

  // ── Picker + preview + confirm ──
  return (
    <Shell>
      <Header />

      <Section label="What did you do?">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {primaries.map(t => (
            <Chip key={t.value} active={eventType === t.value} onClick={() => setEventType(t.value)}>
              <span aria-hidden="true">{t.emoji}</span> {t.label}
            </Chip>
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
                    <Chip key={t.value} active={eventType === t.value} onClick={() => setEventType(t.value)}>
                      <span aria-hidden="true">{t.emoji}</span> {t.label}
                    </Chip>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
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

      <Section label="To which plantings?">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <Chip active={scope.type === 'all'} onClick={() => setScope({ type: 'all' })}>All active</Chip>
          <Chip active={scope.type === 'project'} onClick={() => setScope(s => s.type === 'project' ? s : { type: 'project', project_id: projects[0]?.id })}>By project</Chip>
          <Chip active={scope.type === 'space'} onClick={() => setScope(s => s.type === 'space' ? s : { type: 'space', location_id: locations[0]?.id })}>By space</Chip>
        </div>
        {scope.type === 'project' && (
          <select value={scope.project_id ?? ''} onChange={e => setScope({ type: 'project', project_id: e.target.value })} style={selectStyle} aria-label="Project">
            <ProjectOptions projects={projects} />
          </select>
        )}
        {scope.type === 'space' && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {locations.map(l => (
              <Chip key={l.id} small active={scope.location_id === l.id} onClick={() => setScope({ type: 'space', location_id: l.id })}>{l.name}</Chip>
            ))}
          </div>
        )}
      </Section>

      <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
        {previewing ? (
          <p style={{ margin: 0, color: P.light, textAlign: 'center' }}>Counting…</p>
        ) : preview ? (
          <>
            <p style={{ margin: '0 0 4px', fontWeight: 700, color: P.dark, fontSize: '1rem' }}>
              Log <span style={{ color: P.green }}>{verbLabel}</span> on <span style={{ color: P.green }}>{committed.length}</span> {committed.length === 1 ? 'planting' : 'plantings'}
            </p>
            <p style={{ margin: '0 0 8px', color: P.mid, fontSize: '0.85rem' }}>in {scopeLabel} · one event each, dated {eventDate ? eventDate : 'now'}</p>
            {preview.capped && <p style={{ margin: '0 0 8px', color: P.terra, fontSize: '0.8rem' }}>Showing first 500 — narrow the scope to log more.</p>}
            {scope.type === 'space' && (
              <p style={{ margin: '0 0 8px', color: P.light, fontSize: '0.78rem' }}>Plantings with no space aren't included — use “All active” to cover everything.</p>
            )}
            {preview.plantings.length > 0 && (
              <button type="button" onClick={() => setShowList(v => !v)} style={linkBtn}>
                {showList ? 'Hide' : 'Review'} {preview.plantings.length} {preview.plantings.length === 1 ? 'planting' : 'plantings'} {excluded.size > 0 ? `(${excluded.size} skipped)` : ''}
              </button>
            )}
            {preview.plantings.length > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0 0', fontSize: '0.8rem', color: P.mid, cursor: 'pointer' }}>
                <input type="checkbox" checked={defaultAllSelected} onChange={e => applyDefaultSel(e.target.checked)} />
                Start with everything selected
              </label>
            )}
            {showList && (
              <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {preview.plantings.map(pl => {
                  const off = excluded.has(pl.id)
                  return (
                    <li key={pl.id}>
                      <button type="button" onClick={() => toggleExclude(pl.id)} aria-pressed={!off}
                        style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, minHeight: 40,
                          background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                          color: off ? P.light : P.dark, textDecoration: off ? 'line-through' : 'none', fontSize: '0.88rem' }}>
                        <span aria-hidden="true" style={{ color: off ? P.light : P.green }}>{off ? '○' : '✓'}</span>
                        {pl.name}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        ) : (
          <p style={{ margin: 0, color: P.light, textAlign: 'center' }}>No plantings match this scope.</p>
        )}
      </div>

      {error && <ErrInline msg={error} />}

      <button type="button" onClick={confirm} disabled={saving || committed.length === 0}
        style={{ ...btnPrimary, width: '100%', minHeight: 48, opacity: (saving || committed.length === 0) ? 0.5 : 1,
          cursor: (saving || committed.length === 0) ? 'default' : 'pointer' }}>
        {saving ? 'Logging…' : `Log ${verbLabel} on ${committed.length}`}
      </button>
    </Shell>
  )
}

function Header() {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
      <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Log many</h1>
      <Link to="/log" style={{ color: P.green, fontSize: '0.85rem', fontWeight: 600 }}>Log one →</Link>
    </div>
  )
}
function Section({ label, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <p style={{ margin: '0 0 8px', fontWeight: 600, color: P.dark, fontSize: '0.9rem' }}>{label}</p>
      {children}
    </div>
  )
}
function Chip({ active, small, onClick, children }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      style={{ minHeight: 40, padding: small ? '6px 12px' : '8px 14px', borderRadius: 20, cursor: 'pointer', fontFamily: 'inherit',
        fontSize: small ? '0.82rem' : '0.88rem', fontWeight: 600,
        border: `1px solid ${active ? P.green : P.border}`,
        backgroundColor: active ? P.green : P.white, color: active ? P.white : P.dark }}>
      {children}
    </button>
  )
}
function Shell({ children }) {
  return (
    <div style={{ minHeight: 'calc(100vh - 52px)', backgroundColor: P.cream }}>
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

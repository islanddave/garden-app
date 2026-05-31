import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'

// Bulk "Quick Log" (Unit A). Apply ONE event type to MANY plantings at once —
// one event per planting — without per-item tapping. Scope: All active / By Project /
// By Space. Server resolves the set (POST /api/events/batch); dry_run powers the
// server-accurate preview. Durable undo via /api/events/batches. V100: ambient, no interrupt.

// Primary event types — the 4 most common bulk operations stay above the fold.
const EVENT_TYPES = [
  { value: 'watering',    label: 'Watered',    emoji: '💧' },
  { value: 'fertilizing', label: 'Fertilized', emoji: '🌿' },
  { value: 'observation', label: 'Observed',   emoji: '👁️' },
  { value: 'pruning',     label: 'Pruned',     emoji: '✂️' },
]

// Secondary event types — revealed via "More event types" expand. Curated for batch:
// side-effect-free types only (harvest/first_harvest excluded — they require quantity;
// photo excluded — it requires a file). Order + grouping mirrors EventNew (Log one).
// Vocabulary MUST match the Lambda BATCH_EVENT_TYPES allowlist in lambda/events/validators.js.
const SECONDARY_GROUPS = [
  ['Growth & Training', [
    { value: 'sowing',         label: 'Sowed',         emoji: '🌰' },
    { value: 'seed_soak',      label: 'Seed soak',     emoji: '💦' },
    { value: 'germination',    label: 'Germination',   emoji: '🌿' },
    { value: 'thinning',       label: 'Thinned',       emoji: '🪓' },
    { value: 'potting_up',     label: 'Potted up',     emoji: '🪴' },
    { value: 'transplant',     label: 'Transplanted',  emoji: '🌱' },
    { value: 'hardening_off',  label: 'Hardening off', emoji: '☀️' },
  ]],
  ['Pest & Health', [
    { value: 'pest_treatment', label: 'Pest treatment', emoji: '🐛' },
  ]],
  ['Environmental', [
    { value: 'cover',          label: 'Covered',       emoji: '🌂' },
    { value: 'uncover',        label: 'Uncovered',     emoji: '🌤️' },
    { value: 'other',          label: 'Other',         emoji: '📝' },
  ]],
]

// Flat lookup so the meta-by-value resolver covers both primary + secondary.
const ALL_TYPES = [
  ...EVENT_TYPES,
  ...SECONDARY_GROUPS.flatMap(([, types]) => types),
]

const SCOPE_KEY = 'quicklog.lastScope'

function genKey() {
  try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID() } catch (e) {}
  return 'k-' + Date.now() + '-' + Math.random().toString(16).slice(2)
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
  const [scope, setScope]   = useState({ type: 'all' })
  const [preview, setPreview]   = useState(null)   // { count, capped, plantings:[{id,name}] }
  const [excluded, setExcluded] = useState(() => new Set())
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState(null)       // { batch_id, count }
  const [error, setError]   = useState(null)
  const [showList, setShowList] = useState(false)
  const idemRef = useRef(null)

  // If the user reopens the page with a previously-selected secondary type
  // saved in eventType (e.g. via "Log more"), keep the More panel open so
  // their selection stays visible.
  useEffect(() => {
    if (!EVENT_TYPES.some(t => t.value === eventType)) setShowMoreTypes(true)
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
    fetch('/api/events/batch', { method: 'POST', body: JSON.stringify({ dry_run: true, event_type: eventType, scope }) })
      .then(r => { if (on) { setPreview(r); setPreviewing(false) } })
      .catch(err => { if (on) { setError(err.message); setPreview(null); setPreviewing(false) } })
    return () => { on = false }
  }, [ready, scope, eventType, fetch, result])

  const toggleExclude = useCallback((id) => {
    setExcluded(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }, [])

  const evMeta = ALL_TYPES.find(t => t.value === eventType) || EVENT_TYPES[0]
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
          {EVENT_TYPES.map(t => (
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
            {SECONDARY_GROUPS.map(([category, types]) => (
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

      <Section label="To which plantings?">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <Chip active={scope.type === 'all'} onClick={() => setScope({ type: 'all' })}>All active</Chip>
          <Chip active={scope.type === 'project'} onClick={() => setScope(s => s.type === 'project' ? s : { type: 'project', project_id: projects[0]?.id })}>By project</Chip>
          <Chip active={scope.type === 'space'} onClick={() => setScope(s => s.type === 'space' ? s : { type: 'space', location_id: locations[0]?.id })}>By space</Chip>
        </div>
        {scope.type === 'project' && (
          <select value={scope.project_id ?? ''} onChange={e => setScope({ type: 'project', project_id: e.target.value })} style={selectStyle} aria-label="Project">
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
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
            <p style={{ margin: '0 0 8px', color: P.mid, fontSize: '0.85rem' }}>in {scopeLabel} · one event each, dated now</p>
            {preview.capped && <p style={{ margin: '0 0 8px', color: P.terra, fontSize: '0.8rem' }}>Showing first 500 — narrow the scope to log more.</p>}
            {scope.type === 'space' && (
              <p style={{ margin: '0 0 8px', color: P.light, fontSize: '0.78rem' }}>Plantings with no space aren't included — use “All active” to cover everything.</p>
            )}
            {preview.plantings.length > 0 && (
              <button type="button" onClick={() => setShowList(v => !v)} style={linkBtn}>
                {showList ? 'Hide' : 'Review'} {preview.plantings.length} {preview.plantings.length === 1 ? 'planting' : 'plantings'} {excluded.size > 0 ? `(${excluded.size} skipped)` : ''}
              </button>
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

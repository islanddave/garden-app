import React, { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { shareEntity } from '../lib/shareEntity.js'
import Icon from '../components/Icon.jsx'
import SeverityBadge from '../components/SeverityBadge.jsx'
import { EVENT_TYPE_OPTIONS } from '../lib/dropdownRegistry.js'
import { useAuth } from '../context/AuthContext.jsx'
import PhotoUpload from '../components/PhotoUpload.jsx'
import { Field, Input, Select, Textarea, Button, ErrorBanner } from '../components/forms'
import { PROJECTS_HIDDEN } from '../lib/featureFlags.js'
// BUG-HARVESTEDIT-001: the SAME constants the create form uses. The unit list also mirrors
// harvest_log_unit_check in the database, so an option here that Postgres would reject cannot exist.
import { HARVEST_UNITS, MAX_PLAUSIBLE, WEIGHT_UNITS, MAX_PLAUSIBLE_WEIGHT_G, toGrams } from '../lib/harvest-constants.js'


// V4-HARVWEIGHTREAD-001: the copy map and its deliberate fallback moved to src/lib/harvestWeight.js so
// every harvest surface says the same thing — this page was the ONLY place a weight rendered, and
// then only inside the edit form. Re-exported rather than relocated outright because
// estimateSourceCopy.test.js imports it from here, and that test is a read-path guard worth keeping
// pointed at the consumer as well as at the module. src/lib is also the instrumented tree.
export { estimateSourceCopy } from '../lib/harvestWeight.js'
import { estimateSourceCopy } from '../lib/harvestWeight.js'

// Shared metadata field label map — mirrors EVENT_METADATA_FIELDS keys from EventNew
const METADATA_LABELS = {
  depth_cm:                  'Sowing depth (cm)',
  spacing_cm:                'Spacing (cm)',
  germination_expected_days: 'Expected germination (days)',
  days_to_germinate:         'Days to germinate',
  germination_rate_pct:      'Germination rate (%)',
  height_cm:                 'Height (cm)',
  leaf_count:                'Leaf count',
  health:                    'Health',
  amount_ml:                 'Amount (ml)',
  product:                   'Product / mix',
  dilution:                  'Dilution ratio',
  weight_g:                  'Weight (g)',
  count:                     'Count',
  quality:                   'Quality',
  pest:                      'Pest / disease',
  treatment:                 'Treatment used',
  depth_mm:                  'Sowing depth (mm)',
  medium:                    'Growing medium',
  container:                 'Container',
}

export default function EventDetail() {
  const { id: projectId, eventId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { fetch } = useApiFetch()

  const [event, setEvent] = useState(null)
  const [project, setProject] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    // V4-UNSCOPEDROUTES-001: the event record is the source of truth for its project — the
    // canonical route (/events/:eventId) carries no project param. The :id param survives only
    // for the scoped-redirect window and as a fallback for legacy rows. A failed project fetch
    // degrades the breadcrumb/back-nav, never the event itself.
    let isMounted = true
    ;(async () => {
      try {
        const ev = await fetch('/api/events/' + eventId)
        if (!isMounted) return
        setEvent(ev)
        const pid = ev?.project_id ?? projectId ?? null
        if (pid) {
          try {
            const proj = await fetch('/api/projects/' + pid)
            if (isMounted) setProject(proj)
          } catch { /* breadcrumb degrades; the event still renders */ }
        }
      } catch (e) {
        if (isMounted) setError(e.message)
      }
      if (isMounted) setLoading(false)
    })()
    return () => { isMounted = false }
  }, [eventId, projectId, fetch])

  function startEdit() {
    setForm({
      event_type:    event.event_type,
      event_date:    event.event_date ? new Date(event.event_date).toISOString().split('T')[0] : '',
      title:         event.title ?? '',
      notes:         event.notes ?? '',
      private_notes: event.private_notes ?? '',
      quantity:      event.quantity ?? '',
      is_public:     event.is_public,
      // BUG-HARVESTEDIT-001: seeded from the harvest_log row the GET now returns. These are the
      // values the Harvests page actually totals — event_log.quantity above is a separate free-text
      // field and editing it never touched them.
      harvest_quantity: event.harvest?.quantity != null ? String(event.harvest.quantity) : '',
      harvest_unit:     event.harvest?.unit ?? 'count',
      harvest_quality:  event.harvest?.quality_rating ?? null,
      // V4-HARVDUAL-001: seed the weight box ONLY when the stored grams are the user's own
      // measurement. weight_estimated=false has two causes and they must not be conflated here:
      // a weight the user typed (show it — it is theirs to edit) versus one DERIVED from a
      // weight-unit quantity like "3 lb" (leave blank — the Amount/Unit pair above already owns it).
      // Showing a DERIVED or ESTIMATED number here would be worse than unhelpful: re-saving would
      // promote a guess into a recorded measurement.
      harvest_weight:   (event.harvest?.weight_estimated === false
                         && !WEIGHT_UNITS.includes(event.harvest?.unit)
                         && event.harvest?.weight_grams != null)
        ? String(event.harvest.weight_grams) : '',
      // stored grams are canonical; the unit the user originally typed is not persisted
      harvest_weight_unit: 'g',
    })
    setSaveErr(null)
    setEditing(true)
  }

  // BUG-HARVESTEDIT-001: the edit form's harvest section keys off the event's PERSISTED type, not
  // the dropdown's current value. The server refuses an event_type change that would break the
  // harvest_log pairing in either direction, so showing/hiding these fields as the user scrolls the
  // type dropdown would promise an edit the server will reject.
  const isHarvest = event?.event_type === 'harvest' && event?.harvest != null

  // Mirrors the create form's client-side guard (EventNew validateHarvest) and the server's
  // validateHarvestFields, so the user is told before the round trip rather than by a 400.
  function harvestError() {
    if (!isHarvest) return null
    const qty = Number(form.harvest_quantity)
    if (form.harvest_quantity === '' || !Number.isFinite(qty) || qty <= 0) {
      return 'Enter a harvest amount greater than zero.'
    }
    if (qty > MAX_PLAUSIBLE[form.harvest_unit]) {
      return `That's higher than expected for ${form.harvest_unit} — double-check the amount.`
    }
    // V4-HARVDUAL-001: optional, so blank is valid. Checked before Number() coercion (Number('')
    // is 0, which would read as an entered zero and be rejected).
    if (form.harvest_weight !== '') {
      const w = Number(form.harvest_weight)
      if (!Number.isFinite(w) || w <= 0) return 'Enter a weight greater than zero, or clear the field.'
      if (toGrams(w, form.harvest_weight_unit) > MAX_PLAUSIBLE_WEIGHT_G) {
        return `That's higher than expected for a single weighing — double-check the ${form.harvest_weight_unit}.`
      }
    }
    return null
  }

  async function handleSave(e) {
    e.preventDefault()
    const hErr = harvestError()
    if (hErr) { setSaveErr(hErr); return }
    setSaving(true)
    setSaveErr(null)
    try {
      const eventDate = new Date(form.event_date + 'T12:00:00').toISOString()
      const updated = await fetch('/api/events/' + eventId, {
        method: 'PUT',
        body: JSON.stringify({
          event_type:    form.event_type,
          event_date:    eventDate,
          title:         form.title.trim()         || null,
          notes:         form.notes.trim()         || null,
          private_notes: form.private_notes.trim() || null,
          quantity:      form.quantity.trim()       || null,
          is_public:     form.is_public,
          // Sent ONLY for a harvest event. Absent means "don't touch harvest_log", which is what
          // keeps every non-harvest edit behaviourally identical to before this route existed.
          ...(isHarvest ? { harvest: {
            quantity:       Number(form.harvest_quantity),
            unit:           form.harvest_unit,
            quality_rating: form.harvest_quality,
            // Sent EXPLICITLY, including null. Unlike the create form (which omits the key when
            // blank), this form always represents the user's full intent for the row, so a cleared
            // box must mean "remove my weight" and fall back to the reference estimate. Omitting it
            // would mean "leave whatever is there", which is the opposite of what clearing looks like.
            weight:         form.harvest_weight === '' ? null : Number(form.harvest_weight),
            weight_unit:    form.harvest_weight_unit,
          } } : {}),
        }),
      })
      setEvent(updated)
      setEditing(false)
    } catch (e) {
      setSaveErr(e.message)
    }
    setSaving(false)
  }

  async function handleDelete() {
    if (!window.confirm('Delete this event permanently?')) return
    setDeleting(true)
    try {
      await fetch('/api/events/' + eventId, { method: 'DELETE' })
      // V4-PROJHIDE-001: don't land on the hidden project page post-delete — Home (/today) is the
      // neutral destination when projects aren't user-facing. Flag OFF keeps the project redirect.
      navigate(project && !PROJECTS_HIDDEN ? `/projects/${project.id}` : '/today')
    } catch (e) {
      setError(e.message)
      setDeleting(false)
    }
  }

  if (loading) return <Shell><div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div></Shell>
  // Full-page error only when the page never loaded. Post-load errors (e.g. a failed
  // Delete) surface inline via ErrorBanner so the event content stays visible.
  if (error && !event) return <Shell><div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{error}</div></Shell>
  if (!event) return null

  const icon = <Icon name={`event.${event.event_type}`} size={22} decorative style={{ color: P.green, verticalAlign: '-0.15em' }} />

  return (
    <Shell>
      <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 20 }}>
        {/* V4-PROJHIDE-001: the project crumb is not a user-facing link when projects are hidden —
            fall back to the already-present Home → /today crumb. Flag OFF keeps the project link. */}
        {project && !PROJECTS_HIDDEN ? (
          <Link to={`/projects/${project.id}`} style={{ color: P.green, textDecoration: 'none' }}>
            {project.name}
          </Link>
        ) : (
          <Link to="/today" style={{ color: P.green, textDecoration: 'none' }}>
            Home
          </Link>
        )}
        {' › Event'}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>{icon} {event.title || event.event_type.replace(/_/g, ' ')}</span>
          {event.flagged_as_issue && (
            <SeverityBadge reason="flagged" severity={event.severity} />
          )}
        </h1>
        {!editing && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => shareEntity({ title: event.title || event.event_type.replace(/_/g, ' '), url: window.location.href })} aria-label="Share this event" style={outlineBtn}>Share</button>
            <button onClick={startEdit} style={outlineBtn}>Edit</button>
            <button onClick={handleDelete} disabled={deleting} style={{ ...outlineBtn, color: P.terra, borderColor: P.terra }}>
              {deleting ? '…' : 'Delete'}
            </button>
          </div>
        )}
      </div>

      {!editing && error && <ErrorBanner style={{ marginBottom: 16 }}>{error}</ErrorBanner>}

      {editing ? (
        <form onSubmit={handleSave} style={cardStyle}>
          <h2 style={{ margin: '0 0 18px', fontSize: '1rem', fontWeight: 700, color: P.dark }}>Edit event</h2>
          {saveErr && <ErrorBanner style={{ marginBottom: 16 }}>{saveErr}</ErrorBanner>}

          <Field label="Event type *" htmlFor="ev-event-type" style={{ marginBottom: 14 }}>
            <Select
              id="ev-event-type"
              value={form.event_type}
              onChange={e => setForm(f => ({ ...f, event_type: e.target.value }))}
            >
              {EVENT_TYPE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </Field>

          <Field label="Date *" htmlFor="ev-event-date" style={{ marginBottom: 14 }}>
            <Input
              id="ev-event-date"
              type="date"
              required
              value={form.event_date}
              onChange={e => setForm(f => ({ ...f, event_date: e.target.value }))}
            />
          </Field>

          <Field label="Title (optional)" htmlFor="ev-title" style={{ marginBottom: 14 }}>
            <Input
              id="ev-title"
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="e.g. First true leaves visible"
            />
          </Field>

          <Field label="Quantity (optional)" htmlFor="ev-quantity" style={{ marginBottom: 14 }}>
            <Input
              id="ev-quantity"
              value={form.quantity}
              onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))}
              placeholder="e.g. 6 plants"
            />
          </Field>

          {/* BUG-HARVESTEDIT-001 — the harvest amount that actually counts. Distinct from the free-text
              "Quantity" above, which is a note on the event: THIS pair is the harvest_log row the
              Harvests page totals and the CAL-1 weight derivation reads. Until now it had no UPDATE
              path at all, so a mistyped harvest was permanent. Rendered only for a harvest event that
              has a harvest row — the server refuses type changes that would break that pairing. */}
          {isHarvest && (
            <div data-testid="harvest-edit-fields" style={{ marginBottom: 14, padding: '14px 14px 2px', border: `1px solid ${P.sage}`, borderRadius: 10 }}>
              <p style={{ margin: '0 0 12px', fontSize: '0.82rem', fontWeight: 700, color: P.dark }}>
                Harvest amount
              </p>
              <div style={{ display: 'flex', gap: 10 }}>
                <Field label="Amount *" htmlFor="ev-harvest-qty" style={{ marginBottom: 14, flex: 1 }}>
                  <Input
                    id="ev-harvest-qty"
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    value={form.harvest_quantity}
                    onChange={e => setForm(f => ({ ...f, harvest_quantity: e.target.value }))}
                  />
                </Field>
                <Field label="Unit *" htmlFor="ev-harvest-unit" style={{ marginBottom: 14, flex: 1 }}>
                  <Select
                    id="ev-harvest-unit"
                    value={form.harvest_unit}
                    onChange={e => setForm(f => ({ ...f, harvest_unit: e.target.value }))}
                  >
                    {[...HARVEST_UNITS].sort((a, b) => a.localeCompare(b)).map(u => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </Select>
                </Field>
              </div>

              {/* V4-HARVDUAL-001 Slice B — the optional measured weight. Blank unless the user
                  previously weighed this pick themselves; clearing it removes the measurement and
                  the row falls back to the per-variety reference estimate. */}
              <div style={{ display: 'flex', gap: 10 }}>
                <Field label="Weight (optional)" htmlFor="ev-harvest-weight" style={{ marginBottom: 6, flex: 1 }}>
                  <Input
                    id="ev-harvest-weight"
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    value={form.harvest_weight}
                    onChange={e => setForm(f => ({ ...f, harvest_weight: e.target.value }))}
                    placeholder="e.g. 337"
                  />
                </Field>
                <Field label="Weight unit" htmlFor="ev-harvest-weight-unit" style={{ marginBottom: 6, flex: 1 }}>
                  <Select
                    id="ev-harvest-weight-unit"
                    value={form.harvest_weight_unit}
                    onChange={e => setForm(f => ({ ...f, harvest_weight_unit: e.target.value }))}
                  >
                    {WEIGHT_UNITS.map(u => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              {event.harvest?.weight_estimated === true && (
                <p style={{ margin: '0 0 12px', fontSize: '0.72rem', color: P.light, lineHeight: 1.4 }}>
                  {estimateSourceCopy(event.harvest?.weight_basis)} Enter a real weight to replace it.
                </p>
              )}
            </div>
          )}

          <Field label="Notes (public)" htmlFor="ev-notes" style={{ marginBottom: 14 }}>
            <Textarea
              id="ev-notes"
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Visible on public page…"
              style={{ height: 80, resize: 'vertical' }}
            />
          </Field>

          <Field label="Private notes (never public)" htmlFor="ev-private-notes" style={{ marginBottom: 14 }}>
            <Textarea
              id="ev-private-notes"
              value={form.private_notes}
              onChange={e => setForm(f => ({ ...f, private_notes: e.target.value }))}
              placeholder="Dosage, stress signs, anything you don't want to share…"
              style={{ height: 72, resize: 'vertical', borderColor: P.warnBorder, backgroundColor: P.warn }}
            />
          </Field>

          {/* V4-PUBHIDE-001: is_public toggle removed. */}

          <div style={{ display: 'flex', gap: 12, paddingTop: 16, borderTop: `1px solid ${P.border}` }}>
            <Button type="submit" variant="primary" loading={saving} loadingLabel="Saving…">
              Save changes
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div style={cardStyle}>
          <EventFields event={event} />
        </div>
      )}

      {/* V2-PHOTO-F1 Session 2: attach a photo to this existing event.
          'swallow' mode mirrors EventNew's non-fatal posture — the event already
          exists, so a failed upload should NOT block the user. */}
      {!editing && (
        <div style={{ ...cardStyle, marginTop: 20 }}>
          <h2 style={{ margin: '0 0 12px', fontSize: '0.95rem', fontWeight: 700, color: P.dark }}>
            Add a photo to this event
          </h2>
          <PhotoUpload
            keyPrefix="events"
            parentId={event.id}
            linkage={{ event_id: event.id, project_id: event.project_id ?? projectId ?? null }}
            errorMode="swallow"
            mode="both"
            inputId={`event-photo-${event.id}`}
          />
        </div>
      )}
    </Shell>
  )
}

function EventFields({ event: ev }) {
  const d = new Date(ev.event_date)
  const dateStr = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  const rows = [
    ['Date', dateStr],
    ['Type', ev.event_type.replace(/_/g, ' ')],
    ev.quantity && ['Quantity', ev.quantity],
    ev.notes && ['Notes', ev.notes],
    ev.private_notes && ['Private notes', ev.private_notes],
  ].filter(Boolean)

  // Determine if metadata has any displayable entries
  const metadataEntries = ev.metadata && typeof ev.metadata === 'object'
    ? Object.entries(ev.metadata).filter(([, v]) => v !== null && v !== undefined && v !== '')
    : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {rows.map(([label, value]) => (
        <div key={label}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: P.light, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            {label}
          </div>
          <div style={{ fontSize: '0.9rem', color: P.dark, lineHeight: 1.5 }}>
            {label === 'Private notes' ? (
              <div style={{ backgroundColor: P.warn, borderRadius: 4, padding: '8px 10px', borderLeft: `3px solid ${P.warnBorder}` }}>
                🔒 {value}
              </div>
            ) : (
              value
            )}
          </div>
        </div>
      ))}

      {metadataEntries.length > 0 && (
        <div>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: P.light, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Details
          </div>
          <div style={{
            backgroundColor: P.cream, borderRadius: 8, padding: '12px 14px',
            border: `1px solid ${P.border}`,
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            {metadataEntries.map(([key, value]) => {
              const label = METADATA_LABELS[key] ?? null
              return (
                <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                  <span style={{ fontSize: '0.82rem', color: P.mid, flexShrink: 0 }}>
                    {label ?? <span style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>{key}</span>}
                  </span>
                  <span style={{ fontSize: '0.9rem', color: P.dark, fontWeight: 500, textAlign: 'right' }}>
                    {label ? String(value) : <span style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}>{String(value)}</span>}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px' }}>
        {children}
      </div>
    </div>
  )
}

const cardStyle = { backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 24 }
const outlineBtn = { backgroundColor: 'transparent', color: P.green, border: `1px solid ${P.greenLight}`, borderRadius: 6, padding: '7px 18px', fontSize: '0.85rem', cursor: 'pointer' }

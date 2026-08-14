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
// V4-EVENTDETAILRICH-001 — the read view's three new blocks compose EXISTING primitives rather than
// inventing an EventDetail-only dialect: Lightbox is the same gallery PlantingDetail and PhotosWall
// open, and formatEntry / describeHarvestWeight are the shared harvest vocabulary. Every one of
// these is already mounted on the planting page — which is the point: an event detail is a SUBSET of
// that page, not a second design.
//
// PutUpPhotoThumb, not <PhotoView>, and not <PhotoImg> — see EventPhotos below for the full reason.
import PutUpPhotoThumb from '../components/PutUpPhotoThumb.jsx'
import Lightbox from '../components/Lightbox.jsx'
import { formatEntry } from '../lib/harvestSummary.js'
// DD9 / W-EVTDEL adoption: the disclose-and-offer delete confirm (shared with ProjectDetail's
// event rows — the two delete surfaces must stay behaviorally identical).
import EventDeleteConfirm from '../components/photo/EventDeleteConfirm.jsx'
import { Field, Input, Select, Textarea, Button, ErrorBanner } from '../components/forms'
import { PROJECTS_HIDDEN, EVENT_REANCHOR_ENABLED, WATER_DEPTH_EDIT_ENABLED } from '../lib/featureFlags.js'
// V4-WATERMATH-001 F0 — the amount class is correctable from history (flag-gated; see featureFlags).
import WaterDepthChips from '../components/WaterDepthChips.jsx'
import {
  isWaterDepthType, readWaterDepth, waterDepthMetadata, waterDepthLabel,
} from '../lib/waterDepth.js'
// BUG-HARVESTEDIT-001: the SAME constants the create form uses. The unit list also mirrors
// harvest_log_unit_check in the database, so an option here that Postgres would reject cannot exist.
import { HARVEST_UNITS, MAX_PLAUSIBLE, WEIGHT_UNITS, MAX_PLAUSIBLE_WEIGHT_G, toGrams } from '../lib/harvest-constants.js'


// V4-HARVWEIGHTREAD-001: the copy map and its deliberate fallback moved to src/lib/harvestWeight.js so
// every harvest surface says the same thing — this page was the ONLY place a weight rendered, and
// then only inside the edit form. Re-exported rather than relocated outright because
// estimateSourceCopy.test.js imports it from here, and that test is a read-path guard worth keeping
// pointed at the consumer as well as at the module. src/lib is also the instrumented tree.
export { estimateSourceCopy } from '../lib/harvestWeight.js'
import { estimateSourceCopy, describeHarvestWeight, NO_WEIGHT_COPY } from '../lib/harvestWeight.js'

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
  // V4-WATERMATH-001 F0. `water_depth_source` is deliberately absent: it is model provenance
  // ('user' vs 'default'), not something the user recorded, and rendering it invites a reading
  // of the app's own confidence that the Jen-invisible rule keeps out of non-admin surfaces.
  // Unlabelled keys render in the monospace raw-key fallback below, so omitting it from the
  // labels map is not enough — it is filtered out of the entries list itself.
  water_depth:               'Water amount',
}

// Metadata keys that are MACHINE provenance rather than user-entered detail. Filtered out of the
// rendered Details block (see METADATA_LABELS above for why).
const METADATA_HIDDEN_KEYS = new Set(['water_depth_source'])

// V4-EVTDELCONFIRM-001 — coverFor for the confirm sheet: the union of every photo's cover_for
// entries, deduped by entity (one planting covered by two of the event's photos must be named
// ONCE — the disclosure names parents, not photo-parent pairs). Duplicated verbatim in
// ProjectDetail.jsx: this lane's file budget is the two callsites + lambda + tests, so no shared
// lib module; the two copies must not diverge (same rule as the sheet itself).
function coverForFromPhotos(photos) {
  const seen = new Set()
  const out = []
  for (const ph of photos ?? []) {
    for (const c of ph.cover_for ?? []) {
      const key = `${c.type}:${c.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ id: c.id, name: c.name })
    }
  }
  return out
}

// The partial-failure report, shared copy across both delete surfaces (see handleDelete's header
// comment for the continue-and-report decision this narrates).
function photoDeleteFailureCopy(failed, total) {
  if (total === 1) return 'The event was deleted, but its photo could not be deleted — it is still in your garden photos.'
  return `The event was deleted, but ${failed} of ${total} photos could not be deleted — they are still in your garden photos.`
}

// Value formatters for keys whose stored value is a code, not display text.
const METADATA_VALUE_FORMAT = {
  water_depth: v => waterDepthLabel(v),
}

// The event type in words. Extracted because V4-EVENTDETAILRICH-001 reduced the type to ONE render
// site and three call sites had the `.replace(/_/g, ' ')` inline — three chances for the header, the
// kicker and the share title to drift apart on a type nobody has looked at in a year.
function eventTypeLabel(type) {
  return String(type ?? '').replace(/_/g, ' ')
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
  const [confirmingDelete, setConfirmingDelete] = useState(false)

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
      // BUG-EVENTEDITFIELDS-001 slice 2. These were creatable and not editable: the PUT never
      // wrote them and, for the five treatment columns, the GET never even returned them. Seeded
      // from the SAVED row so an unrelated edit round-trips them unchanged.
      flagged_as_issue: event.flagged_as_issue === true,
      severity:         event.severity ?? null,
      treatment_product_text: event.treatment_product_text ?? '',
      treatment_category:     event.treatment_category ?? '',
      treatment_amount:       event.treatment_amount ?? '',
      pest_target:            event.pest_target ?? '',
      // slice 4: the re-anchor target. Seeded from the current anchor so "no change" is the
      // default and an untouched form can never move the event.
      plant_id:   event.plant_id ?? null,
      project_id: event.project_id ?? null,
      // V4-WATERMATH-001 F0: seeded from the SAVED row. A row with no class (historical, or one
      // written before capture shipped) seeds to the default — the same value the engine fold
      // already assumes for it — so opening the editor never silently reclassifies anything.
      water_depth: readWaterDepth(event.metadata),
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
      // Derived from the RENDERED field set only. A key enters `clear` when the saved row held a
      // value and the form is now empty — never merely because the key is absent from state.
      const isTreatmentType = form.event_type === 'pest_treatment' || form.event_type === 'doctored'
      const clearKeys = []
      if (isTreatmentType) {
        for (const k of ['treatment_product_text', 'treatment_category', 'treatment_amount', 'pest_target']) {
          if (String(form[k] ?? '').trim() === '' && event[k] != null) clearKeys.push(k)
        }
      }

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
          // BUG-EVENTEDITFIELDS-001 slice 2 + 4. Built declaratively rather than as a hand-written
          // literal: `clear` is derived ONLY from keys this form actually renders, and only when
          // the field held a value before and is empty now. That is what stops the save from
          // NULLing a column the form never showed — the mirror-image of the bug being fixed, and
          // the failure mode the varieties editor avoids by driving render/seed/patch off one table.
          flagged_as_issue: form.flagged_as_issue,
          // Sent together with the flag: the server refuses a severity without it and clears the
          // severity when the flag goes false, so the client must never construct the mismatch.
          ...(form.flagged_as_issue ? { severity: form.severity } : {}),
          ...(isTreatmentType ? {
            treatment_product_text: form.treatment_product_text.trim() || null,
            treatment_category:     form.treatment_category || null,
            treatment_amount:       form.treatment_amount.trim() || null,
            pest_target:            form.pest_target.trim() || null,
          } : {}),
          // slice 4, flag-gated. Absent when the flag is off, so the server's re-anchor path is
          // never entered and EventDetail's save is byte-identical to before.
          ...(EVENT_REANCHOR_ENABLED && form.plant_id !== (event.plant_id ?? null)
            ? { plant_id: form.plant_id, project_id: form.project_id }
            : {}),
          // V4-WATERMATH-001 F0: sent as a MERGE over the row's existing metadata, never as a
          // replacement — this form renders exactly one metadata key and must not null the rest
          // (the same rule the `clear` channel above exists to enforce for columns). An edited
          // class is always source='user': the default only ever writes itself at creation.
          ...(WATER_DEPTH_EDIT_ENABLED && isWaterDepthType(form.event_type)
            ? { metadata: {
                ...(event.metadata && typeof event.metadata === 'object' ? event.metadata : {}),
                ...waterDepthMetadata(form.water_depth, true),
              } }
            : {}),
          ...(clearKeys.length ? { clear: clearKeys } : {}),
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

  // DD9 / W-EVTDEL adoption: the header Delete tap ARMS the EventDeleteConfirm sheet (rendered at
  // the bottom of this page); this function runs only from that sheet's Delete button. The event
  // DELETE call is byte-identical to the window.confirm era — only the confirm step changed, and
  // with it the copy: the old "Delete this event permanently?" was untruthful, this route has been
  // SOFT-delete-only since 2026-06-10 (deleted_at; photos detach + re-parent, BUG-EVTCASCADE-001).
  //
  // V4-EVTDELCONFIRM-001 — the photo path is now REACHABLE. GET /api/events/:id reports the
  // event's live photos + cover usage (see lambda/events/eventPhotos.js), so the sheet's offer and
  // disclosure are populated below, and onConfirm's { deletePhotos } is honored here:
  //   • UNCHECKED (the asserted default) is the pre-DD9 behavior EXACTLY — the server detaches and
  //     re-parents the photos; no photo write fires from this client.
  //   • CHECKED fires the live DELETE /api/photos/:id per photo, ONLY after the event DELETE
  //     succeeded. Those deletes are W-DEL SOFT deletes — recoverable from Recently deleted
  //     forever — which is what lets the sheet's copy promise that truthfully.
  //   • PARTIAL FAILURE is continue-and-report: the photo deletes are independent, idempotent soft
  //     deletes, so one failure must not strand the rest — and a failed delete leaves that photo
  //     exactly where the unchecked path leaves all of them (live in the gallery). The report is
  //     an honest count in the inline banner, with NO navigation: leaving the page would discard
  //     the only surface the message has. ProjectDetail.confirmEventDelete mirrors these semantics
  //     verbatim — the two event-delete surfaces must not diverge.
  async function handleDelete({ deletePhotos } = {}) {
    setDeleting(true)
    try {
      await fetch('/api/events/' + eventId, { method: 'DELETE' })
    } catch (e) {
      setError(e.message)
      setDeleting(false)
      setConfirmingDelete(false) // close the sheet so the inline ErrorBanner is visible
      return
    }
    if (deletePhotos && eventPhotos.length > 0) {
      // busy={deleting} keeps the sheet up and disabled across these too — never closed
      // optimistically over writes that may fail.
      const results = await Promise.allSettled(
        eventPhotos.map(p => fetch('/api/photos/' + p.id, { method: 'DELETE' }))
      )
      const failed = results.filter(r => r.status === 'rejected').length
      if (failed > 0) {
        setError(photoDeleteFailureCopy(failed, eventPhotos.length))
        setDeleting(false)
        setConfirmingDelete(false)
        return
      }
    }
    // V4-PROJHIDE-001: don't land on the hidden project page post-delete — Home (/today) is the
    // neutral destination when projects aren't user-facing. Flag OFF keeps the project redirect.
    navigate(project && !PROJECTS_HIDDEN ? `/projects/${project.id}` : '/today')
  }

  // The Delete tap arms the sheet and re-reads the event BEHIND it: PhotoUpload sits on this very
  // page, so the mount-time photo set can be stale by the time a delete is armed. Non-blocking
  // (the sheet opens instantly on the data already loaded) and non-fatal (a failed refresh keeps
  // the mount data — a smaller offer, never a blocked delete).
  function armDelete() {
    setConfirmingDelete(true)
    fetch('/api/events/' + eventId).then(ev => { if (ev) setEvent(ev) }).catch(() => {})
  }

  if (loading) return <Shell><div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div></Shell>
  // Full-page error only when the page never loaded. Post-load errors (e.g. a failed
  // Delete) surface inline via ErrorBanner so the event content stays visible.
  if (error && !event) return <Shell><div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{error}</div></Shell>
  if (!event) return null

  // V4-EVTDELCONFIRM-001: the event's photos, from the GET (see handleDelete's header comment).
  // `?? []` tolerates an old Lambda paired with a new client — absence degrades the sheet to its
  // unchecked default (no photo write), which is the pre-DD9 behavior exactly.
  const eventPhotos = event.photos ?? []

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

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 24 }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span>{icon} {event.title || eventTypeLabel(event.event_type)}</span>
            {event.flagged_as_issue && (
              <SeverityBadge reason="flagged" severity={event.severity} />
            )}
          </h1>
          {/* V4-EVENTDETAILRICH-001 — "drop the repeated type field". The Type ROW is gone from the
              read view; the type is stated ONCE, here. Rendered only when a title exists: with no
              title the <h1> above already IS the humanised type, and printing it again beneath
              itself is the exact repetition the ticket names. With a title the type would otherwise
              survive only as the header glyph — and on a generic `observation` the type is the one
              thing identifying the event, so it keeps a words form rather than being deleted
              outright (recon D3.2). */}
          {event.title && (
            <div data-testid="event-type-kicker" style={{ marginTop: 4, fontSize: '0.78rem', color: P.light, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>
              {eventTypeLabel(event.event_type)}
            </div>
          )}
        </div>
        {!editing && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => shareEntity({ title: event.title || eventTypeLabel(event.event_type), url: window.location.href })} aria-label="Share this event" style={outlineBtn}>Share</button>
            <button onClick={startEdit} style={outlineBtn}>Edit</button>
            <button onClick={armDelete} disabled={deleting} style={{ ...outlineBtn, color: P.terra, borderColor: P.terra }}>
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

          {/* V4-WATERMATH-001 F0 — correct the amount class of an already-logged watering.
              Keyed off the form's CURRENT type (unlike the harvest panel, which keys off the
              persisted type): there is no paired row to orphan here, so re-typing an event INTO
              watering may legitimately give it a class. Sits outside <Field> — one-control
              contract. Flag-gated: see WATER_DEPTH_EDIT_ENABLED for why. */}
          {WATER_DEPTH_EDIT_ENABLED && isWaterDepthType(form.event_type) && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: '0.77rem', fontWeight: 700, color: P.mid, marginBottom: 8, letterSpacing: '0.4px', textTransform: 'uppercase' }}>
                How much water
              </label>
              <WaterDepthChips
                value={form.water_depth}
                onChange={v => setForm(f => ({ ...f, water_depth: v }))}
                idPrefix="ev-water-depth"
              />
            </div>
          )}

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

          {/* BUG-EVENTEDITFIELDS-001 slice 2 — flag + severity. Previously SeverityBadge RENDERED
              the severity and nothing could change it: the user could see the wrong urgency on a
              flagged issue and had no way to correct it. 72 rows on prod were in that state. */}
          <Field label="Flag as an issue" htmlFor="ev-flagged" style={{ marginBottom: 14 }}>
            {/* No nested <label>: Field already renders one bound via htmlFor, and wrapping the
                input in a second label makes the outer one non-labellable — the control becomes
                unreachable by its accessible name. Caught by the a11y-shaped query in the test. */}
            <input
              id="ev-flagged"
              type="checkbox"
              checked={form.flagged_as_issue}
              onChange={e => setForm(f => ({
                ...f,
                flagged_as_issue: e.target.checked,
                // Un-flagging drops the severity in the same gesture, mirroring the server, so a
                // stale value can never ride along into a request the server would refuse.
                severity: e.target.checked ? (f.severity ?? 2) : null,
              }))}
            />
          </Field>

          {form.flagged_as_issue && (
            <Field label="Severity *" htmlFor="ev-severity" style={{ marginBottom: 14 }}>
              <Select
                id="ev-severity"
                value={form.severity ?? 2}
                onChange={e => setForm(f => ({ ...f, severity: Number(e.target.value) }))}
              >
                <option value={1}>1 — minor</option>
                <option value={2}>2 — moderate</option>
                <option value={3}>3 — serious</option>
              </Select>
            </Field>
          )}

          {/* The five treatment columns, rendered only for the two types that own them — matching
              the server's isTreatment gate exactly. Rendering them on other types would let the
              form offer edits the server silently discards. */}
          {(form.event_type === 'pest_treatment' || form.event_type === 'doctored') && (
            <>
              <Field label="Product (optional)" htmlFor="ev-treat-product" style={{ marginBottom: 14 }}>
                <Input id="ev-treat-product" value={form.treatment_product_text}
                  onChange={e => setForm(f => ({ ...f, treatment_product_text: e.target.value }))} />
              </Field>
              <Field label="Category (optional)" htmlFor="ev-treat-category" style={{ marginBottom: 14 }}>
                <Select id="ev-treat-category" value={form.treatment_category}
                  onChange={e => setForm(f => ({ ...f, treatment_category: e.target.value }))}>
                  <option value="">—</option>
                  <option value="fertilizer">Fertilizer</option>
                  <option value="amendment">Amendment</option>
                  <option value="pest_control">Pest control</option>
                  <option value="other">Other</option>
                </Select>
              </Field>
              <Field label="Amount (optional)" htmlFor="ev-treat-amount" style={{ marginBottom: 14 }}>
                <Input id="ev-treat-amount" value={form.treatment_amount}
                  onChange={e => setForm(f => ({ ...f, treatment_amount: e.target.value }))} />
              </Field>
              <Field label="Pest / target (optional)" htmlFor="ev-pest-target" style={{ marginBottom: 14 }}>
                <Input id="ev-pest-target" value={form.pest_target}
                  onChange={e => setForm(f => ({ ...f, pest_target: e.target.value }))} />
              </Field>
            </>
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

      {/* DD9 / W-EVTDEL: kept mounted-open with busy={deleting} while the write is in flight, per
          the component's contract — never closed optimistically over a request that may fail.
          V4-EVTDELCONFIRM-001: photoCount/coverFor now populated from the event's own GET. */}
      <EventDeleteConfirm
        open={confirmingDelete}
        photoCount={eventPhotos.length}
        coverFor={coverForFromPhotos(eventPhotos)}
        busy={deleting}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={handleDelete}
      />
    </Shell>
  )
}

// ── V4-EVENTDETAILRICH-001 (BD0806-18) ───────────────────────────────────────────────────────────
// "Event detail pages are too sparse (harvest worst)." The read view rendered five label/value rows
// and nothing else: on a harvest it showed the free-text event_log.quantity — a note — while the
// harvest_log amount, the weight, the planting it came off, and the photos attached to it were ALL
// already on the wire and ALL invisible. You had to tap Edit to see the amount you picked.
//
// The shape of the fix is Dave's own: an event detail is a SUBSET of the planting page. So each
// block below is that page's treatment, narrowed to one event — same glyph, same formatter, same
// weight vocabulary, same gallery. No new dialect.
//
// A shared uppercase label, so the new blocks sit in the same visual grammar as the rows they join.
function FieldLabel({ children, style }) {
  return (
    <div style={{ fontSize: '0.75rem', fontWeight: 600, color: P.light, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px', ...style }}>
      {children}
    </div>
  )
}

// ⚠️ CROSS-LANE CONTRACT — fleet 20260813, pinned in BOTH lane briefs before either lane started.
//
//   GET /api/events/:id carries the planting's display name as the field `planting_name` — a
//   string, and null when the event has no planting anchor.
//
// The server half (the one-line widening of the GET's SELECT) is a SIBLING LANE and a SEPARATE
// deploy. This client therefore ships into a window where the key is simply ABSENT, and absent is
// handled identically to null — the un-anchored render. It is deliberately NOT backfilled from
// project_name or any other field: a project is not a planting, and quietly substituting one would
// put a wrong name under a "Planting" label, which is worse than no label at all.
//
// A blank/whitespace name is treated as absent for the same reason — an empty labelled row is a
// defect that reads as data.
function PlantingAnchor({ event: ev }) {
  const raw = ev.planting_name
  const name = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
  if (!name) return null
  // lifecycle.sprout is PlantingDetail's OWN planting glyph (PlantingDetail.jsx:320) — the icon the
  // ticket asks for, taken from the page this one subsets. The CROP-specific icon is a different
  // ask: it needs variety_ref.crop_type_slug, i.e. a second join this GET does not make, and it is
  // deferred rather than guessed (recon D3.1).
  const label = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      <Icon name="lifecycle.sprout" size={17} decorative style={{ color: P.greenLight, flexShrink: 0 }} />
      {name}
    </span>
  )
  return (
    <div data-testid="event-planting">
      <FieldLabel>Planting</FieldLabel>
      <div style={{ fontSize: '0.95rem', fontWeight: 600, color: P.dark, lineHeight: 1.4 }}>
        {/* Canonical un-scoped planting route (V4-UNSCOPEDROUTES-001). Linked only when the event
            actually carries the anchor id — a name with no id is still worth showing, just not as a
            link to nowhere. */}
        {ev.plant_id
          ? <Link to={`/plantings/${ev.plant_id}`} style={{ color: P.green, textDecoration: 'none' }}>{label}</Link>
          : label}
      </div>
    </div>
  )
}

// The harvest readout — the block this ticket exists for. Two axes, in the order the rest of the app
// puts them: the NATIVE-unit amount is the headline ("6 zucchini" is what was picked), grams are the
// second axis (Harvests.jsx:387-393, PlantingDetail's HarvestWeightChip).
//
// Two deliberate choices:
//  • formatEntry is called with countNoun = null. This GET has no crop noun (planting_name is a
//    display name — "3 Celebrity Rescues" is not English), and the shared formatter's contract is
//    that 'count' is a SCHEMA token which renders as a bare number when no noun is known, NEVER as
//    "3 count" (harvestSummary.js:199). Passing planting_name here would break that rule; Harvests.jsx
//    excludes planting_name from its own countNoun for the same reason.
//  • The provenance sentence is rendered VISIBLY, not as a title= tooltip. Every other weight surface
//    delivers it through `title` + aria-label, and Dave is on Chrome/Android where a title tooltip
//    never fires on touch — so on his device those surfaces reduce to a lone ≈ glyph. This page has
//    the room, and its own EDIT form already prints the sentence in full, so the read view matches
//    the editor rather than the tooltip.
function HarvestReadout({ harvest }) {
  const amount = harvest?.quantity != null
    ? formatEntry({ quantity: harvest.quantity, unit: harvest.unit }, null)
    : null
  const wt = describeHarvestWeight(harvest)
  return (
    <div data-testid="event-harvest">
      <FieldLabel>Harvest amount</FieldLabel>
      {amount
        ? (
          <div data-testid="event-harvest-amount" style={{ fontSize: '1.05rem', fontWeight: 700, color: P.dark, lineHeight: 1.3 }}>
            {amount}
          </div>
        )
        : (
          // Mirrors the Harvests log's wording for a harvest row with no amount recorded, so the
          // same state does not read two different ways on two screens.
          <div data-testid="event-harvest-amount" style={{ fontSize: '0.9rem', color: P.light, lineHeight: 1.4 }}>
            harvest logged — no amount recorded
          </div>
        )}
      {wt.state === 'none' ? (
        // NOT an error: the ratchet state that improves the next time something is weighed.
        <div data-testid="event-harvest-weight-none" style={{ marginTop: 6, fontSize: '0.8rem', color: P.light, lineHeight: 1.4 }}>
          {NO_WEIGHT_COPY}
        </div>
      ) : (
        <div style={{ marginTop: 6 }}>
          <div
            data-testid="event-harvest-weight"
            aria-label={`${wt.estimated ? 'Estimated weight' : 'Weighed'}: ${wt.text}`}
            style={{ fontSize: '0.9rem', fontWeight: 600, color: wt.estimated ? P.light : P.green }}
          >
            {wt.estimated ? `≈ ${wt.text}` : wt.text}
          </div>
          {/* BASIS VOCABULARY — two registers, deliberately, one rule:
              a DENSE ROW gets the compressed label (weightBasisLabel → "typical for this variety",
              "weighed"); a DETAIL PAGE gets the full sentence (ESTIMATE_SOURCE_COPY → "Currently
              estimated from this variety's typical weight."). This is the detail page, so it takes
              the sentence — it has the room, and it is the surface someone opens *because* they want
              to know where the number came from.
              Both registers come from the same module and the same basis value, so they cannot
              disagree about facts, only about length. (Corrected 2026-08-13: the note here used to
              claim 'Weighed.' was "the same word the other surfaces put in their title=" — the row
              surfaces now render a visible "weighed" label of their own, so that sentence was
              describing a world that no longer exists.) */}
          <div data-testid="event-harvest-weight-basis" style={{ marginTop: 2, fontSize: '0.78rem', color: P.light, lineHeight: 1.4 }}>
            {wt.sourceCopy ?? 'Weighed.'}
          </div>
        </div>
      )}
    </div>
  )
}

// The event's own photos.
//
// ⚠️ WHY NOT <PhotoView>, THE MANDATED PRIMITIVE. GET /api/events/:id returns
// { id, storage_path, cover_for } and NO view_url / thumb_url — presigning lives in the photos
// Lambda and eventPhotos.js deliberately does not reach for it. PhotoView resolves what to render
// from photoModel's `sources`, and with no URL on the row that chain is EMPTY, so PhotoView renders
// `null` (PhotoView.jsx: `if (!p || !source) return null`). It cannot express an ID-ONLY photo today.
//
// PutUpPhotoThumb is the repo's EXISTING answer to exactly that shape — preservation_log has the
// same problem (a photo_id whose Lambda resolves no URL) and the same resolution: hand the id to
// PhotoImg's fetch-on-mount path (A2b P1) and let it mint against the household-scoped
// GET /api/photos/view-url/:id. It is allow-listed in photoPrimitive.static.test.js for that reason.
// Reusing it here is a naming stretch (its default alt says "Put-up photo", overridden below) but it
// is the right MECHANISM, and it keeps this page out of the raw-<PhotoImg> ratchet the drift guard
// is defending. THE REAL FIX is a ~3-line id-only arm in PhotoView (empty chain + p.id present →
// render PhotoImg with photoId and no initialUrl), which would then let BOTH this surface and
// PutUpPhotoThumb leave that allow-list. That file belongs to no lane in this fleet, so it is
// reported, not edited — see the lane report.
//
// Tap opens the SAME shared Lightbox gallery the planting page uses; Lightbox resolves a slide by
// `photoId ?? id` and tolerates a missing `src`, so the id-only rows feed it unmodified.
// (PlantingDetail's lbFrozen snapshot is unnecessary here: this list comes off the event payload and
// is not refetched while the gallery is open, so plain state suffices.)
const PHOTO_THUMB_PX = 96

function EventPhotos({ photos }) {
  const [lightboxIndex, setLightboxIndex] = useState(null)
  const list = photos ?? []
  if (list.length === 0) return null
  return (
    <div data-testid="event-photos">
      <FieldLabel style={{ marginBottom: 10 }}>
        Photos
        <span style={{ marginLeft: 6, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>({list.length})</span>
      </FieldLabel>
      {/* flex-wrap rather than a fluid grid: PutUpPhotoThumb sizes itself in px and forwards no
          style, so a 1fr track would not stretch it and would only add dead space. At the 390px
          Android reference width this lands three thumbs per row. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {list.map((ph, i) => (
          <button
            key={ph.id}
            type="button"
            onClick={() => setLightboxIndex(i)}
            aria-label={`Open photo ${i + 1} of ${list.length}`}
            style={{ display: 'block', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', lineHeight: 0 }}
          >
            <PutUpPhotoThumb photoId={ph.id} size={PHOTO_THUMB_PX} alt={`Photo ${i + 1} of ${list.length} on this event`} />
          </button>
        ))}
      </div>
      <Lightbox
        open={lightboxIndex != null}
        images={list}
        index={lightboxIndex ?? 0}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
      />
    </div>
  )
}

function EventFields({ event: ev }) {
  const d = new Date(ev.event_date)
  const dateStr = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  // The harvest readout keys off the PERSISTED type paired with an actual harvest_log row — the same
  // discriminator the edit panel uses (see `isHarvest` above). A 'harvest' event with no paired row
  // has no amount to show and must fall through to the plain rows.
  const isHarvestRead = ev.event_type === 'harvest' && ev.harvest != null

  // NOTE the absent ['Type', …] row: V4-EVENTDETAILRICH-001 moved it to the header (see the kicker).
  // `Quantity` here is event_log.quantity — free text, a note on the event. It is NOT the harvest
  // amount, and on a harvest it now sits BELOW the real amount rather than impersonating it.
  const rows = [
    ['Date', dateStr],
    ev.quantity && ['Quantity', ev.quantity],
    ev.notes && ['Notes', ev.notes],
    ev.private_notes && ['Private notes', ev.private_notes],
  ].filter(Boolean)

  // Determine if metadata has any displayable entries
  const metadataEntries = ev.metadata && typeof ev.metadata === 'object'
    ? Object.entries(ev.metadata).filter(([k, v]) =>
        v !== null && v !== undefined && v !== '' && !METADATA_HIDDEN_KEYS.has(k))
    : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PlantingAnchor event={ev} />
      {isHarvestRead && <HarvestReadout harvest={ev.harvest} />}
      {rows.map(([label, value]) => (
        <div key={label}>
          <FieldLabel>{label}</FieldLabel>
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

      <EventPhotos photos={ev.photos} />

      {metadataEntries.length > 0 && (
        <div>
          <FieldLabel style={{ marginBottom: 10 }}>Details</FieldLabel>
          <div style={{
            backgroundColor: P.cream, borderRadius: 8, padding: '12px 14px',
            border: `1px solid ${P.border}`,
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            {metadataEntries.map(([key, rawValue]) => {
              const label = METADATA_LABELS[key] ?? null
              const value = METADATA_VALUE_FORMAT[key] ? METADATA_VALUE_FORMAT[key](rawValue) : rawValue
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

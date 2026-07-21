// src/pages/PutUp.jsx
// V4-HARVESTCENTER-001 "Put-Up" — the post-harvest preservation log + "what's put up" read surface.
// Route-backed, overlayable (App.jsx renderRoutes, path /put-up); when the OVERLAY flag is on it opens
// as a Sheet flyover (OverlayHost) and when off it renders full-page — byte-identical route element.
//
// TWO views behind a segmented toggle (design V101 §4):
//   'log'    — the put-up form. PROGRESSIVE DISCLOSURE: crop + quantity are the 2 required fast-path
//              fields; method / storage / use-by are shown pre-defaulted; photo/notes/#packages hide
//              behind a "More" reveal. Prefilled from location.state.prefill when launched off the
//              harvest-log "preserve this?" trigger (L9); else the user picks a crop.
//   'stores' — "what's put up": grouped inventory (default by storage location, one-tap regroup by
//              crop), numbers-first headline per group (package count + the distinct units present,
//              NEVER summed across incompatible units — L5), NULL storage → "Unassigned". Per-row
//              edit + soft-delete + a minimal "mark used / used up" decrement (L4).
//
// Rules honored: Reward-UX (cadence-utility, no streak/celebration/interrupt); Soft-Delete (deleted
// rows vanish from the read surface — the Lambda filters deleted_at IS NULL, we just refetch);
// Cross-Device (all state server-side). Offline = require-online: the save is blocked with a clear
// "can't save offline" state that PRESERVES entered input (no draft queue in V100 — tech-debt).
import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { useCropTypes } from '../hooks/useCropTypes.js'
import { P } from '../lib/constants.js'
import { Field, Input, Select, Textarea, Button, ErrorBanner, SegmentedControl } from '../components/forms'
import VarietyPicker from '../components/VarietyPicker.jsx'

// ── Vocabulary (mirrors lambda/preservation VALID_METHODS + lambda/storage-location VALID_KINDS) ──
// Grouped for the picker; the canning SAFETY split (water-bath = high-acid, pressure = low-acid) is
// made legible at log time (L5) — full guidance deferred to the crop guides.
const METHOD_GROUPS = [
  { group: 'Freeze', options: [
    { value: 'whole_freeze',  label: 'Freeze (raw / whole)' },
    { value: 'blanch_freeze', label: 'Blanch & freeze' },
    { value: 'roast_freeze',  label: 'Roast & freeze' },
  ] },
  { group: 'Dry', options: [
    { value: 'dehydrate', label: 'Dehydrate' },
    { value: 'powder',    label: 'Powder' },
  ] },
  { group: 'Cook down / can', options: [
    { value: 'passata',        label: 'Passata / sauce' },
    { value: 'can_water_bath', label: 'Water-bath can (high-acid)' },
    { value: 'can_pressure',   label: 'Pressure can (low-acid)' },
    { value: 'jam_preserve',   label: 'Jam / preserve' },
  ] },
  { group: 'Store', options: [
    { value: 'ferment',    label: 'Ferment' },
    { value: 'cure_store', label: 'Cure & store' },
    { value: 'cold_store', label: 'Cold store (root cellar)' },
    { value: 'other',      label: 'Other…' },
  ] },
]
const METHOD_LABELS = Object.fromEntries(METHOD_GROUPS.flatMap(g => g.options).map(o => [o.value, o.label]))
const CANNING_METHODS = new Set(['can_water_bath', 'can_pressure'])

// Curated unit pick-list (L5) — free-text units make "how many quarts left" un-queryable. Weight /
// count / volume / container classes. Grouped views list per-record units and never sum across them.
const UNIT_GROUPS = [
  { group: 'Weight',     options: ['lbs', 'oz'] },
  { group: 'Count',      options: ['count'] },
  { group: 'Volume',     options: ['cups', 'pints', 'quarts'] },
  { group: 'Containers', options: ['jars', 'bags'] },
]

const STORAGE_KINDS = [
  { value: 'deep_freezer',   label: 'Deep freezer' },
  { value: 'fridge_freezer', label: 'Fridge freezer' },
  { value: 'fridge',         label: 'Fridge' },
  { value: 'pantry',         label: 'Pantry' },
  { value: 'cold_storage',   label: 'Cold storage / root cellar' },
  { value: 'other',          label: 'Other' },
]

// Local-time YYYY-MM-DD (toISOString would shift behind-UTC offsets a day). Accepts a Date, an ISO
// string, or a YYYY-MM-DD — the neon driver hands dates back as JS Date objects on the read surface.
function ymd(v) {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(typeof v === 'string' && v.length === 10 ? v + 'T00:00:00' : v)
  if (isNaN(d.getTime())) return typeof v === 'string' ? v.slice(0, 10) : ''
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function todayYMD() { return ymd(new Date()) }

function prettyDate(v) {
  const s = ymd(v)
  if (!s) return ''
  const d = new Date(s + 'T00:00:00')
  return isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function PutUp() {
  const location = useLocation()
  const prefill = (location.state && typeof location.state.prefill === 'object' && location.state.prefill) || {}
  const hasPrefill = !!(prefill.crop_type_slug || prefill.variety_id || prefill.plant_id || prefill.harvest_log_id)

  // Adaptive default: a harvest-triggered open lands on the form; a bare "Put-Up" tap lands on the
  // inventory ("what have I got?") — the more common intent from the More menu.
  const [view, setView] = useState(hasPrefill ? 'log' : 'stores')

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 620, margin: '0 auto', padding: '24px 18px 80px' }}>
        <h1 style={{ margin: '0 0 4px', color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Put-Up</h1>
        <p style={{ margin: '0 0 16px', fontSize: '0.84rem', color: P.light }}>
          What you&rsquo;ve preserved from the garden — your freezer, pantry and stores.
        </p>

        <div style={{ marginBottom: 18 }}>
          <SegmentedControl
            ariaLabel="Put-Up view"
            value={view}
            onChange={setView}
            options={[
              { value: 'log',    label: 'Log a put-up' },
              { value: 'stores', label: "What's put up" },
            ]}
          />
        </div>

        {view === 'log'
          ? <PutUpForm prefill={prefill} onLogged={() => setView('stores')} />
          : <StoresView />}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Log form
// ─────────────────────────────────────────────────────────────────────────────
function PutUpForm({ prefill, onLogged }) {
  const { fetch } = useApiFetch()
  const { cropTypes } = useCropTypes()

  // Fast-path (2 required)
  const [cropSlug, setCropSlug]   = useState(prefill.crop_type_slug || '')
  const [qtyValue, setQtyValue]   = useState('')
  const [qtyUnit, setQtyUnit]     = useState('lbs')

  // Defaulted (visible, pre-filled)
  const [method, setMethod]       = useState('whole_freeze')
  const [methodOther, setMethodOther] = useState('')
  const [preservedAt, setPreservedAt] = useState(todayYMD())
  const [storageId, setStorageId] = useState('')
  const [useByMode, setUseByMode] = useState('auto') // 'auto' | 'none' | 'custom'
  const [useByDate, setUseByDate] = useState('')

  // Behind "More"
  const [showMore, setShowMore]   = useState(false)
  const [packageCount, setPackageCount] = useState('1')
  const [notes, setNotes]         = useState('')
  const [variety, setVariety]     = useState(null)

  const [storageLocations, setStorageLocations] = useState([])
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState(null)
  const [success, setSuccess]     = useState(null)

  // Provenance carried from the harvest trigger (L9) — never shown, submitted verbatim.
  const plantId = prefill.plant_id || null
  const harvestLogId = prefill.harvest_log_id || null
  const prefillVarietyId = prefill.variety_id || null
  const effectiveVarietyId = variety?.id ?? prefillVarietyId ?? null

  const loadStorage = useCallback(() => {
    fetch('/api/storage-locations')
      .then(rows => setStorageLocations(Array.isArray(rows) ? rows : []))
      .catch(() => { /* non-fatal — Unassigned is always available */ })
  }, [fetch])
  useEffect(() => { loadStorage() }, [loadStorage])

  function validate() {
    if (!cropSlug && !effectiveVarietyId) return 'Pick a crop (or a variety) so this put-up is attributed.'
    const q = Number(qtyValue)
    if (qtyValue === '' || !Number.isFinite(q) || q <= 0) return 'Enter how much you put up (greater than zero).'
    if (!qtyUnit) return 'Pick a unit.'
    if (method === 'other' && !methodOther.trim()) return 'Describe the method when you choose "Other".'
    if (!preservedAt) return 'When did you put this up?'
    if (packageCount !== '' && Number(packageCount) < 1) return 'Number of containers must be at least 1.'
    if (useByMode === 'custom' && !useByDate) return 'Pick a use-by date, or switch to Auto / No expiry.'
    return null
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    // Offline = require-online. Block the save, keep every entered value, name the state plainly.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setError("You're offline — a put-up can't be saved right now. Your entries are kept; try again once you're back online.")
      return
    }
    const verr = validate()
    if (verr) { setError(verr); return }

    const body = {
      preserved_at: preservedAt,
      method,
      quantity_value: Number(qtyValue),
      quantity_unit: qtyUnit,
      package_count: packageCount === '' ? 1 : Number(packageCount),
    }
    if (cropSlug) body.crop_type_slug = cropSlug
    if (effectiveVarietyId) body.variety_id = effectiveVarietyId
    if (plantId) body.plant_id = plantId
    if (harvestLogId) body.harvest_log_id = harvestLogId
    if (method === 'other') body.method_other_text = methodOther.trim()
    if (storageId) body.storage_location_id = storageId
    if (notes.trim()) body.notes = notes.trim()
    // use_by_target: OMIT the key for the shelf-life auto-default; null for "no expiry"; a date otherwise.
    if (useByMode === 'none') body.use_by_target = null
    else if (useByMode === 'custom') body.use_by_target = useByDate

    setSaving(true)
    try {
      const row = await fetch('/api/preservation', { method: 'POST', body: JSON.stringify(body) })
      // L10 cold-start competence payoff — reflect it straight back into the inventory, no celebration.
      const storeLabel = storageLocations.find(s => String(s.id) === String(storageId))?.label || 'your stores'
      const cropLabel = cropTypes.find(c => c.slug === cropSlug)?.display_name || variety?.name || 'harvest'
      setSuccess({
        text: `Now in ${storeLabel}: ${Number(qtyValue)} ${qtyUnit} ${cropLabel} (${body.package_count} ${body.package_count === 1 ? 'container' : 'containers'}).`,
        row,
      })
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setSaving(false)
    }
  }

  function resetForNext() {
    setQtyValue(''); setNotes(''); setPackageCount('1'); setVariety(null)
    setSuccess(null); setError(null)
  }

  if (success) {
    return (
      <div>
        <div role="status" style={{
          backgroundColor: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: 10,
          padding: '16px 18px', marginBottom: 16,
        }}>
          <div style={{ fontWeight: 700, color: P.green, fontSize: '0.98rem', marginBottom: 4 }}>✓ Put up</div>
          <div style={{ fontSize: '0.9rem', color: P.mid }}>{success.text}</div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Button type="button" variant="primary" onClick={resetForNext}>Log another</Button>
          <Button type="button" variant="secondary" onClick={onLogged}>See what&rsquo;s put up</Button>
        </div>
      </div>
    )
  }

  const offline = typeof navigator !== 'undefined' && navigator.onLine === false

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {offline && !error && (
        <ErrorBanner>You&rsquo;re offline — you can fill this in, but saving needs a connection.</ErrorBanner>
      )}

      {/* ── Fast path: crop + quantity ── */}
      <Card>
        <Field label="Crop *" htmlFor="pu-crop" help={effectiveVarietyId && !cropSlug ? 'Linked to your harvest — pick a crop to refine, or leave as is.' : undefined}>
          <Select id="pu-crop" value={cropSlug} onChange={e => setCropSlug(e.target.value)} aria-label="Crop">
            <option value="">— Select a crop —</option>
            {[...cropTypes].sort((a, b) => (a.display_name || '').localeCompare(b.display_name || '')).map(c => (
              <option key={c.slug} value={c.slug}>{c.display_name}</option>
            ))}
          </Select>
        </Field>

        {/* Which one? Crop alone ("Peppers") isn't enough to know what's in the jar — jalapeño vs
            habanero matters when you go looking for it later. Promoted out of the "More" reveal to
            sit with the crop (Dave, 2026-07-21). Optional: the attribution CHECK needs crop OR variety. */}
        <div style={{ marginTop: 14 }}>
          <Field label="Which variety?" htmlFor="pu-variety" optional
            help={cropSlug
              ? 'e.g. Jalapeño, Habanero — so you know exactly what you put up.'
              : 'Choose a crop above to narrow this list — or search them all.'}>
            {/* Scoped to the chosen crop so this is a short, relevant list (pepper = 107 of 398)
                rather than every variety in the garden. */}
            <VarietyPicker id="pu-variety" value={variety} onChange={setVariety}
              cropSlugFilter={cropSlug || undefined}
              placeholder={cropSlug ? 'Search this crop’s varieties…' : 'Search varieties…'} />
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <div style={{ flex: 2 }}>
            <Field label="How much *" htmlFor="pu-qty">
              <Input
                id="pu-qty"
                type="text"
                inputMode="decimal"
                value={qtyValue}
                onChange={e => setQtyValue(e.target.value)}
                aria-label="Quantity"
                placeholder="e.g. 14"
              />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Unit *" htmlFor="pu-unit">
              <Select id="pu-unit" value={qtyUnit} onChange={e => setQtyUnit(e.target.value)} aria-label="Unit">
                {UNIT_GROUPS.map(g => (
                  <optgroup key={g.group} label={g.group}>
                    {g.options.map(u => <option key={u} value={u}>{u}</option>)}
                  </optgroup>
                ))}
              </Select>
            </Field>
          </div>
        </div>
      </Card>

      {/* ── Defaulted: method / storage / date / use-by ── */}
      <Card>
        <Field label="How did you put it up?" htmlFor="pu-method">
          <Select id="pu-method" value={method} onChange={e => setMethod(e.target.value)} aria-label="Method">
            {METHOD_GROUPS.map(g => (
              <optgroup key={g.group} label={g.group}>
                {g.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </optgroup>
            ))}
          </Select>
        </Field>
        {method === 'other' && (
          <div style={{ marginTop: 12 }}>
            <Field label="Describe the method *" htmlFor="pu-method-other">
              <Input id="pu-method-other" value={methodOther} onChange={e => setMethodOther(e.target.value)}
                aria-label="Describe the method" placeholder="e.g. smoked" />
            </Field>
          </div>
        )}
        {CANNING_METHODS.has(method) && (
          <div role="note" style={{
            marginTop: 12, fontSize: '0.8rem', lineHeight: 1.45, color: P.bannerInk,
            backgroundColor: P.warn, border: `1px solid ${P.warnBorder}`, borderRadius: 8, padding: '10px 12px',
          }}>
            <strong>Canning safety.</strong> Water-bath canning is safe only for <strong>high-acid</strong> foods
            (tomatoes with added acid, pickles, jam). <strong>Low-acid</strong> foods — beans, most vegetables —
            must be <strong>pressure-canned</strong> to be safe. Check the crop guide before you can.
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <StorageField
            value={storageId}
            onChange={setStorageId}
            locations={storageLocations}
            onCreated={(row) => { setStorageLocations(list => [...list, row]); setStorageId(String(row.id)) }}
            fetch={fetch}
          />
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 150 }}>
            <Field label="Put-up date *" htmlFor="pu-date">
              <Input id="pu-date" type="date" value={preservedAt} max={todayYMD()}
                onChange={e => setPreservedAt(e.target.value)} aria-label="Put-up date" />
            </Field>
          </div>
          <div style={{ flex: 1, minWidth: 150 }}>
            <Field label="Use by" htmlFor="pu-useby-mode" help="Auto uses tested shelf-life for the method and storage.">
              <Select id="pu-useby-mode" value={useByMode} onChange={e => setUseByMode(e.target.value)} aria-label="Use by">
                <option value="auto">Auto (recommended)</option>
                <option value="none">No expiry</option>
                <option value="custom">Pick a date</option>
              </Select>
            </Field>
          </div>
        </div>
        {useByMode === 'custom' && (
          <div style={{ marginTop: 12 }}>
            <Field label="Use-by date" htmlFor="pu-useby-date">
              <Input id="pu-useby-date" type="date" value={useByDate}
                onChange={e => setUseByDate(e.target.value)} aria-label="Use-by date" />
            </Field>
          </div>
        )}
      </Card>

      {/* ── More: packages / notes / variety ── */}
      <Card>
        <button type="button" onClick={() => setShowMore(s => !s)} aria-expanded={showMore}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.mid, fontSize: '0.82rem',
            fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', padding: 0,
            display: 'flex', alignItems: 'center', gap: 6 }}>
          <span aria-hidden="true">{showMore ? '▾' : '▸'}</span>
          <span>More &middot; optional</span>
        </button>
        {showMore && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="Number of containers" htmlFor="pu-packages" help="How many bags / jars / boxes.">
              <Input id="pu-packages" type="number" min={1} value={packageCount}
                onChange={e => setPackageCount(e.target.value)} aria-label="Number of containers" />
            </Field>
            <Field label="Notes" htmlFor="pu-notes" optional>
              <Textarea id="pu-notes" value={notes} onChange={e => setNotes(e.target.value)}
                aria-label="Notes" style={{ height: 72, resize: 'vertical' }} placeholder="Anything worth remembering" />
            </Field>
          </div>
        )}
      </Card>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button type="submit" variant="primary" loading={saving} loadingLabel="Saving…"
          disabled={offline} style={{ minWidth: 160 }}>
          Save put-up
        </Button>
      </div>
    </form>
  )
}

// Inline storage-location field with a lightweight "＋ New location" creator (POST /api/storage-locations).
function StorageField({ value, onChange, locations, onCreated, fetch }) {
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState('deep_freezer')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  async function create() {
    if (!label.trim()) { setErr('Give the location a name.'); return }
    setBusy(true); setErr(null)
    try {
      const row = await fetch('/api/storage-locations', { method: 'POST', body: JSON.stringify({ label: label.trim(), kind }) })
      onCreated(row)
      setAdding(false); setLabel(''); setKind('deep_freezer')
    } catch (e) {
      setErr("Couldn't add that location — try again.")
    } finally { setBusy(false) }
  }

  return (
    <div>
      <Field label="Where is it stored?" htmlFor="pu-storage">
        <Select id="pu-storage" value={value} onChange={e => onChange(e.target.value)} aria-label="Storage location">
          <option value="">— Unassigned —</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
        </Select>
      </Field>
      {!adding ? (
        <button type="button" onClick={() => setAdding(true)}
          style={{ background: 'none', border: 'none', color: P.green, cursor: 'pointer', fontSize: '0.82rem',
            fontWeight: 600, padding: '8px 0 0', textDecoration: 'underline' }}>
          ＋ New location
        </button>
      ) : (
        <div style={{ marginTop: 12, border: `1px solid ${P.border}`, borderRadius: 8, padding: '12px 14px', backgroundColor: P.cream }}>
          {err && <div role="alert" style={{ color: P.terra, fontSize: '0.78rem', marginBottom: 8 }}>{err}</div>}
          <Field label="Name *" htmlFor="pu-newloc-label">
            <Input id="pu-newloc-label" value={label} onChange={e => setLabel(e.target.value)}
              aria-label="New location name" placeholder="e.g. Garage freezer" />
          </Field>
          <div style={{ marginTop: 10 }}>
            <Field label="Kind" htmlFor="pu-newloc-kind">
              <Select id="pu-newloc-kind" value={kind} onChange={e => setKind(e.target.value)} aria-label="Location kind">
                {STORAGE_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
              </Select>
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <Button type="button" variant="primary" loading={busy} loadingLabel="Adding…" onClick={create}>Add</Button>
            <Button type="button" variant="secondary" onClick={() => { setAdding(false); setErr(null) }}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// "What's put up" read surface
// ─────────────────────────────────────────────────────────────────────────────
function StoresView() {
  const { fetch } = useApiFetch()
  const [group, setGroup] = useState('storage') // 'storage' | 'crop'
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback((g) => {
    setLoading(true); setError(null)
    fetch(`/api/preservation/whats-put-up?group=${g}`)
      .then(d => setData(d ?? { groups: [] }))
      .catch(() => setError("Couldn't load your stores — try again."))
      .finally(() => setLoading(false))
  }, [fetch])

  useEffect(() => { load(group) }, [load, group])

  const groups = data?.groups ?? []

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <SegmentedControl
          ariaLabel="Group by"
          small
          value={group}
          onChange={setGroup}
          options={[
            { value: 'storage', label: 'By storage' },
            { value: 'crop',    label: 'By crop' },
          ]}
        />
      </div>

      {loading && <div style={{ padding: 24, textAlign: 'center', color: P.light }}>Loading&hellip;</div>}
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {!loading && !error && groups.length === 0 && (
        <div style={{ padding: '28px 18px', textAlign: 'center', color: P.mid,
          background: P.white, border: `1px solid ${P.border}`, borderRadius: 12 }}>
          <div style={{ fontWeight: 700, color: P.dark, marginBottom: 6 }}>Nothing put up yet.</div>
          <div style={{ fontSize: '0.85rem', color: P.light }}>
            Log your first put-up and it&rsquo;ll show up here, grouped by where it&rsquo;s stored.
          </div>
        </div>
      )}

      {!loading && !error && groups.map(g => (
        <GroupCard key={g.group_key} group={g} onChanged={() => load(group)} fetch={fetch} />
      ))}
    </div>
  )
}

function GroupCard({ group, onChanged, fetch }) {
  const units = (group.units ?? []).join(', ')
  return (
    <div style={{ marginBottom: 16, backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${P.border}` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ fontWeight: 700, color: P.dark, fontSize: '1rem' }}>{group.label}</div>
          {group.use_soon_count > 0 && (
            <span style={{ fontSize: '0.72rem', fontWeight: 700, color: P.gold,
              backgroundColor: P.warn, border: `1px solid ${P.warnBorder}`, borderRadius: 999, padding: '2px 8px' }}>
              {group.use_soon_count} use soon
            </span>
          )}
        </div>
        {/* Numbers-first headline — package COUNT + the distinct units present. Never a cross-unit sum (L5). */}
        <div style={{ fontSize: '0.85rem', color: P.mid, marginTop: 4 }}>
          {group.total_packages} {group.total_packages === 1 ? 'container' : 'containers'}
          {units ? ` · ${units}` : ''}
        </div>
      </div>
      <div>
        {group.records.map(rec => <RecordRow key={rec.id} rec={rec} onChanged={onChanged} fetch={fetch} />)}
      </div>
    </div>
  )
}

// Build the FULL replace payload the PUT contract expects, applying overrides (decrement / edit).
function buildFullPayload(rec, overrides = {}) {
  return {
    crop_type_slug: rec.crop_type_slug ?? null,
    variety_id: rec.variety_id ?? null,
    plant_id: rec.plant_id ?? null,
    harvest_log_id: rec.harvest_log_id ?? null,
    preserved_at: ymd(rec.preserved_at),
    method: rec.method,
    method_other_text: rec.method_other_text ?? null,
    quantity_value: rec.quantity_value,
    quantity_unit: rec.quantity_unit,
    package_count: rec.package_count ?? 1,
    storage_location_id: rec.storage_location_id ?? null,
    use_by_target: rec.use_by_target ? ymd(rec.use_by_target) : null,
    remaining_count: rec.remaining_count ?? null,
    consumed_at: rec.consumed_at ?? null,
    notes: rec.notes ?? null,
    photo_id: rec.photo_id ?? null,
    ...overrides,
  }
}

function RecordRow({ rec, onChanged, fetch }) {
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [err, setErr] = useState(null)

  const remaining = rec.remaining_count ?? rec.package_count ?? 0

  async function put(overrides) {
    setBusy(true); setErr(null)
    try {
      await fetch(`/api/preservation/${rec.id}`, { method: 'PUT', body: JSON.stringify(buildFullPayload(rec, overrides)) })
      onChanged()
    } catch (e) { setErr("Couldn't update — try again."); setBusy(false) }
  }

  async function markUsed() {
    const next = Math.max(0, Number(remaining) - 1)
    await put({ remaining_count: next })
  }
  async function usedUp() { await put({ remaining_count: 0 }) }

  async function doDelete() {
    setBusy(true); setErr(null)
    try {
      await fetch(`/api/preservation/${rec.id}`, { method: 'DELETE' })
      onChanged()
    } catch (e) { setErr("Couldn't remove — try again."); setBusy(false) }
  }

  if (editing) {
    return <RowEditor rec={rec} onCancel={() => setEditing(false)}
      onSave={async (overrides) => { await put(overrides); setEditing(false) }} busy={busy} err={err} />
  }

  const status = rec.use_by_status
  const statusChip = status === 'past_use_by'
    ? { text: 'Past use-by', bg: P.warn, border: P.warnBorder, color: P.bannerInk }
    : status === 'use_soon'
      ? { text: 'Use soon', bg: P.warn, border: P.warnBorder, color: P.gold }
      : null

  return (
    <div style={{ padding: '12px 16px', borderTop: `1px solid ${P.cream}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
        <div style={{ fontWeight: 600, color: P.dark, fontSize: '0.92rem' }}>
          {rec.quantity_value} {rec.quantity_unit}
          <span style={{ color: P.mid, fontWeight: 400 }}> · {METHOD_LABELS[rec.method] || rec.method}{rec.method === 'other' && rec.method_other_text ? ` (${rec.method_other_text})` : ''}</span>
        </div>
        {statusChip && (
          <span style={{ fontSize: '0.68rem', fontWeight: 700, color: statusChip.color,
            backgroundColor: statusChip.bg, border: `1px solid ${statusChip.border}`, borderRadius: 999, padding: '2px 8px', flexShrink: 0 }}>
            {statusChip.text}
          </span>
        )}
      </div>
      <div style={{ fontSize: '0.78rem', color: P.light, marginTop: 3 }}>
        {rec.package_count} {rec.package_count === 1 ? 'container' : 'containers'}
        {remaining !== rec.package_count ? ` · ${remaining} left` : ''}
        {' · put up '}{prettyDate(rec.preserved_at)}
        {rec.use_by_target ? ` · use by ${prettyDate(rec.use_by_target)}` : ''}
      </div>
      {rec.notes && <div style={{ fontSize: '0.8rem', color: P.mid, marginTop: 4 }}>{rec.notes}</div>}
      {err && <div role="alert" style={{ color: P.terra, fontSize: '0.78rem', marginTop: 6 }}>{err}</div>}

      <div style={{ display: 'flex', gap: 14, marginTop: 8, flexWrap: 'wrap' }}>
        <RowAction onClick={markUsed} disabled={busy || remaining <= 0}>Mark used</RowAction>
        <RowAction onClick={usedUp} disabled={busy || remaining <= 0}>Used up</RowAction>
        <RowAction onClick={() => setEditing(true)} disabled={busy}>Edit</RowAction>
        {!confirmDelete ? (
          <RowAction onClick={() => setConfirmDelete(true)} disabled={busy} tone="terra">Remove</RowAction>
        ) : (
          <>
            <RowAction onClick={doDelete} disabled={busy} tone="terra">Confirm remove</RowAction>
            <RowAction onClick={() => setConfirmDelete(false)} disabled={busy}>Cancel</RowAction>
          </>
        )}
      </div>
    </div>
  )
}

function RowAction({ onClick, disabled, tone, children }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      style={{ background: 'none', border: 'none', padding: '4px 0', cursor: disabled ? 'default' : 'pointer',
        color: disabled ? P.light : (tone === 'terra' ? P.terra : P.green), fontSize: '0.82rem', fontWeight: 600,
        fontFamily: 'inherit', textDecoration: 'underline', opacity: disabled ? 0.5 : 1, minHeight: 32 }}>
      {children}
    </button>
  )
}

// Minimal per-row editor — the fields worth changing after the fact. Sends a FULL replace payload.
function RowEditor({ rec, onCancel, onSave, busy, err }) {
  const [qtyValue, setQtyValue] = useState(String(rec.quantity_value ?? ''))
  const [qtyUnit, setQtyUnit] = useState(rec.quantity_unit || 'lbs')
  const [packageCount, setPackageCount] = useState(String(rec.package_count ?? 1))
  const [method, setMethod] = useState(rec.method || 'whole_freeze')
  const [notes, setNotes] = useState(rec.notes || '')

  function save() {
    onSave({
      quantity_value: Number(qtyValue) || rec.quantity_value,
      quantity_unit: qtyUnit,
      package_count: packageCount === '' ? 1 : Number(packageCount),
      method,
      notes: notes.trim() || null,
    })
  }

  return (
    <div style={{ padding: '14px 16px', borderTop: `1px solid ${P.cream}`, backgroundColor: P.cream }}>
      {err && <div role="alert" style={{ color: P.terra, fontSize: '0.78rem', marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 2 }}>
          <Field label="How much" htmlFor={`ed-qty-${rec.id}`}>
            <Input id={`ed-qty-${rec.id}`} type="text" inputMode="decimal" value={qtyValue}
              onChange={e => setQtyValue(e.target.value)} aria-label="Quantity" />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="Unit" htmlFor={`ed-unit-${rec.id}`}>
            <Select id={`ed-unit-${rec.id}`} value={qtyUnit} onChange={e => setQtyUnit(e.target.value)} aria-label="Unit">
              {UNIT_GROUPS.map(g => (
                <optgroup key={g.group} label={g.group}>
                  {g.options.map(u => <option key={u} value={u}>{u}</option>)}
                </optgroup>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <Field label="Containers" htmlFor={`ed-pkg-${rec.id}`}>
          <Input id={`ed-pkg-${rec.id}`} type="number" min={1} value={packageCount}
            onChange={e => setPackageCount(e.target.value)} aria-label="Number of containers" />
        </Field>
      </div>
      <div style={{ marginTop: 10 }}>
        <Field label="Method" htmlFor={`ed-method-${rec.id}`}>
          <Select id={`ed-method-${rec.id}`} value={method} onChange={e => setMethod(e.target.value)} aria-label="Method">
            {METHOD_GROUPS.map(g => (
              <optgroup key={g.group} label={g.group}>
                {g.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </optgroup>
            ))}
          </Select>
        </Field>
      </div>
      <div style={{ marginTop: 10 }}>
        <Field label="Notes" htmlFor={`ed-notes-${rec.id}`} optional>
          <Textarea id={`ed-notes-${rec.id}`} value={notes} onChange={e => setNotes(e.target.value)}
            aria-label="Notes" style={{ height: 60, resize: 'vertical' }} />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
        <Button type="button" variant="primary" loading={busy} loadingLabel="Saving…" onClick={save}>Save</Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  )
}

function Card({ children }) {
  return (
    <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '16px 18px' }}>
      {children}
    </div>
  )
}

function friendlyError(err) {
  const status = err && err.status
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return err?.message ? `Couldn't save — ${err.message}` : "Something didn't look right — check the form and try again."
  }
  return "Couldn't save — try again."
}

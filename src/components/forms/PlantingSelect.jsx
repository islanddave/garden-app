// src/components/forms/PlantingSelect.jsx
// V4-PLANTPICKER-001 — THE shared planting picker (spec v4-metaphoto-plantingtarget
// IMPLEMENTATION-SPEC §6.5). Six hand-rolled pickers preceded this (EventNew, PhotoLibrary ×2,
// PutUp PlantingField, CaptureFlow ×2); each held a behavior the others lacked, so this composes
// the UNION with explicit props — "migrate to the best one" would silently drop features.
// Searchable combobox modeled on VarietyPicker (the exemplar): unscoped lists are garden-sized,
// so a bare <select> no longer works — and the listbox opens on focus in browse mode showing ALL
// candidates, so PutUp's "see the waves side by side" select behavior is preserved, not replaced.
// Deliberately NOT a 4-mode TargetPicker (SelectChip precedent: "compose, don't overload") —
// multi-target scope stays in ScopeChecklist; this is the single-planting seam only.
//
// Prop defaults follow the MAJORITY site's value so a dropped prop is a visible diff (spec §6.5).
// No includeArchived prop: lambda/plants GET filters archived_at IS NULL in BOTH list branches,
// so no client can ever receive an archived row — a prop that can never act would only mislead.
//
// The empty state means three incompatible things across sites; a `required` boolean cannot
// express the difference (spec §6.5). Modeled as emptyMeaning:
//   'unset'         — nothing chosen yet / invalid            (EventNew, CaptureFlow ×2)
//   'none'          — deliberately not tied to a planting     (PutUp — load-bearing, must survive)
//   'project-level' — deliberately logged at project level    (PhotoLibrary upload + tag modal)
// It controls the placeholder copy + the accessible description; clearing (chip ✕) returns to it.
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useApiFetch } from '../../lib/api.js'
import { P } from '../../lib/constants.js'
import { T, inputChrome } from './formStyles.js'
import { formatQty } from '../../lib/format.js'
import { PROJECTS_HIDDEN } from '../../lib/featureFlags.js'

// Max rows rendered in the listbox — VarietyPicker precedent: cap VISIBLY (footer row), never
// truncate silently. Unscoped garden lists run to the hundreds; 200 keeps the DOM sane.
const MAX_RESULTS = 200

function prettyDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// 'wave' label — succession disambiguation (from PutUp's plantingOptionLabel, moved here so the
// dependency points page→component; PutUp re-exports it for its provenance display).
// Three "Dark Green Zucchini" rows are indistinguishable by name, so each option carries its
// succession ordinal and sown date.
export function plantingWaveLabel(p) {
  const base = p.name || p.variety_ref?.name || 'Planting'
  const bits = []
  if (p.succession_order != null) bits.push(`wave ${p.succession_order}`)
  if (p.sown_at) { const d = prettyDate(p.sown_at); if (d) bits.push(`sown ${d}`) }
  return bits.length ? `${base} — ${bits.join(', ')}` : base
}

// 'qtyVariety' label — the EventNew/PhotoLibrary majority format.
// V4-PICKERUX-001: the em-dash promises distinguishing information. When a planting is named after
// its cultivar — the common case for herbs and perennials — it delivered "Lemon Thyme — Lemon
// Thyme", forcing a second read to discover the second half is empty, on the highest-frequency
// label shape and at the width that pushes later rows into an ellipsis.
// The rule is deliberately ASYMMETRIC. Equal-after-normalization drops, and name-contains-variety
// drops (the name is the more specific string, so the variety adds nothing) — but NOT
// variety-contains-name: "Jalapeño — Early Jalapeño" must keep its variety, because "Early" is the
// whole point. A symmetric containment test reads as the tidier rule and silently destroys that.
const normLabel = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

export function plantingQtyVarietyLabel(p) {
  const name = p.name ?? ''
  const variety = p.variety_ref?.name ?? ''
  const n = normLabel(name)
  const v = normLabel(variety)
  const redundant = !!v && (v === n || (!!n && n.includes(v)))
  return `${name}${p.quantity > 1 ? ` ×${formatQty(p.quantity)}` : ''}${variety && !redundant ? ` — ${variety}` : ''}`
}

const LABELERS = {
  qtyVariety: plantingQtyVarietyLabel,
  wave: plantingWaveLabel,
  bare: (p) => p.name ?? p.variety_ref?.name ?? 'Planting',
}

const EMPTY_PLACEHOLDER = {
  unset: 'Search plantings…',
  none: '— Not tied to a planting —',
  'project-level': '— All plants (project level) —',
}

export default function PlantingSelect({
  value = '',
  // onChange(id: string, planting: object|null) — id '' on clear. The row rides along so call
  // sites (CaptureFlow submit, PutUp derive) never need their own id→row lookup.
  onChange,
  // Controlled data mode: when `plants` is set the component NEVER fetches — the site owns the
  // list (EventNew's deep-link/sticky validation, PhotoLibrary's per-project effects, CaptureFlow's
  // shared fetch). Absent → self-fetch: unscoped /api/plants, or ?project_id= via scopeProjectId.
  plants,
  scopeProjectId,
  // Progressive scoping (PutUp): a variety pins the list exactly; a crop narrows to that crop's
  // plantings; with neither we offer everything rather than an empty list the user can't explain.
  varietyId,
  cropSlug,
  // PutUp trap (spec §6.5): the selected planting may sit OUTSIDE the current scope (prefilled
  // from a harvest, or the user narrowed the crop afterwards). true = keep it listed + selected;
  // false (majority) = out-of-scope selection renders as unset.
  retainOutOfScopeValue = false,
  sort = 'name',              // 'name' (majority) | 'sown' (PutUp: planting order)
  labelFormat = 'qtyVariety', // 'qtyVariety' (majority) | 'wave' (PutUp) | 'bare' (CaptureFlow)
  emptyMeaning = 'unset',     // see header — 'unset' (majority) | 'none' | 'project-level'
  required = false,
  disabled = false,
  // EventNew: the picker is disabled until a project is chosen, and the disabled control itself
  // must say WHY ("— select a project first —") — a silently disabled required field is the P5
  // failure mode this component exists to prevent.
  disabledHint,
  placeholder,
  id,
  onDerive,     // PutUp back-propagation: ({ crop_type_slug, variety_id, variety }) on selection
  onLoadError,  // PutUp graceful-failure contract: surface load failure, stay non-fatal
  // V4-PICKERUX-001 — onOpenChange(open: boolean). OPTIONAL, no-op default: the other six call
  // sites are untouched. It exists because a host page cannot otherwise know not to render a
  // competing control over the open listbox — EventNew's sticky Save was painting over rows 2-3
  // AND taking their taps, saving events detached from the planting being chosen.
  // Deliberately NOT threaded through the eight setOpen() sites: one effect on `open` below
  // covers every path (focus, type, arrow, escape, blur-timeout, select, chip "Change") and
  // cannot drift when a ninth is added.
  onOpenChange,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  'data-testid': dataTestId,
}) {
  const { fetch: apiFetch } = useApiFetch()
  const [fetched, setFetched] = useState([])
  const [loading, setLoading] = useState(plants == null)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [touched, setTouched] = useState(false)
  const inputRef = useRef(null)
  const listboxId = useMemo(() => `ps-list-${Math.random().toString(36).slice(2, 9)}`, [])

  const controlled = plants != null
  const rows = controlled ? plants : fetched

  // V4-PICKERUX-001 — the single notification point for `open`. Keyed on `open` ONLY: keying it on
  // the callback identity would re-fire on every parent render (callers pass inline closures), and
  // an effect keyed on a per-render identity is exactly the BUG-SOWFOCUS-001 shape. Read through a
  // ref so a non-memoized handler still cannot retrigger it.
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  useEffect(() => { onOpenChangeRef.current?.(open) }, [open])
  // The listbox unmounts with the component while still open (route change, sheet dismiss, the
  // chip-mode swap). Without this the host is left believing a picker is open forever — for
  // EventNew that means a permanently hidden Save button.
  useEffect(() => () => { onOpenChangeRef.current?.(false) }, [])

  useEffect(() => {
    if (controlled) return
    let live = true
    setLoading(true)
    setFailed(false)
    apiFetch(scopeProjectId ? `/api/plants?project_id=${scopeProjectId}` : '/api/plants')
      .then(data => { if (live) setFetched(Array.isArray(data) ? data : []) })
      .catch(err => { if (live) { setFailed(true); onLoadError?.(err) } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [apiFetch, controlled, scopeProjectId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Scope → search → sort ─────────────────────────────────────────────────
  const candidates = useMemo(() => {
    let list = rows
    if (varietyId) list = list.filter(p => String(p.variety_id ?? p.variety_ref?.id ?? '') === String(varietyId))
    else if (cropSlug) list = list.filter(p => p.variety_ref?.crop_type_slug === cropSlug)
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.variety_ref?.name || '').toLowerCase().includes(q) ||
        (p.project_name || '').toLowerCase().includes(q)
      )
    }
    if (sort === 'sown') {
      return [...list].sort((a, b) => {
        const at = a.sown_at ? Date.parse(a.sown_at) : Infinity
        const bt = b.sown_at ? Date.parse(b.sown_at) : Infinity
        if (at !== bt) return (isNaN(at) ? Infinity : at) - (isNaN(bt) ? Infinity : bt)
        return (a.name || '').localeCompare(b.name || '')
      })
    }
    return [...list].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }, [rows, varietyId, cropSlug, query, sort])

  const selected = useMemo(
    () => rows.find(p => String(p.id) === String(value)) || null,
    [rows, value],
  )

  // Out-of-scope retention (PutUp): silently dropping the current value would blank the field
  // and quietly discard the link. Prepend it so it stays visible AND selectable.
  const listed = useMemo(() => {
    if (retainOutOfScopeValue && selected && !candidates.some(p => String(p.id) === String(selected.id))) {
      return [selected, ...candidates]
    }
    return candidates
  }, [retainOutOfScopeValue, selected, candidates])

  const visible = useMemo(() => listed.slice(0, MAX_RESULTS), [listed])
  const hiddenCount = listed.length - visible.length

  // V4-PICKERUX-001: the project tag discriminates nothing when every visible row carries the same
  // project — which is the norm, because EventNew/PhotoLibrary feed a list already scoped by
  // project. It cost horizontal width on every row, and width is what pushes later rows into an
  // ellipsis. Suppressed on CARDINALITY rather than on the PROJECTS_HIDDEN flag beside it, so it
  // self-corrects whichever way the list is later fed.
  const showProjectTag = useMemo(
    () => new Set(visible.map(p => p.project_name).filter(Boolean)).size > 1,
    [visible],
  )

  useEffect(() => { setHighlight(0) }, [query, rows])

  const label = LABELERS[labelFormat] ?? LABELERS.qtyVariety

  const select = useCallback((p) => {
    onChange?.(p ? String(p.id) : '', p ?? null)
    if (p && onDerive) {
      onDerive({
        crop_type_slug: p.variety_ref?.crop_type_slug ?? null,
        variety_id: p.variety_id ?? p.variety_ref?.id ?? null,
        variety: p.variety_ref ?? null,
      })
    }
    setOpen(false)
    setQuery('')
    setTouched(true)
  }, [onChange, onDerive])

  const clear = useCallback(() => {
    onChange?.('', null)
    setTouched(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [onChange])

  const onKeyDown = (e) => {
    if (disabled) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      setHighlight(h => Math.min(visible.length - 1, h + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(h => Math.max(0, h - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      if (visible[highlight]) select(visible[highlight])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      inputRef.current?.blur()
    }
  }

  const onBlur = () => {
    // Delay close so a listbox click (which preventDefaults mousedown to keep input focus)
    // lands first — VarietyPicker convention.
    setTimeout(() => setOpen(false), 150)
    setTouched(true)
  }

  // ── Chip mode: a selection is made and the picker is at rest ──────────────
  if (selected && !open) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={chipStyle(disabled)} aria-live="polite" data-testid={dataTestId ? `${dataTestId}-chip` : undefined}>
          <span style={{ fontSize: '0.88rem', fontWeight: 600, color: P.green }}>
            {label(selected)}
          </span>
          {/* V4-PROJHIDE-001: the secondary project_name tag is hidden when projects aren't user-facing
              (extends the existing labelFormat!=='wave' suppression). Flag OFF renders it as before. */}
          {selected.project_name && labelFormat !== 'wave' && !PROJECTS_HIDDEN && (
            <span style={{ fontSize: '0.74rem', color: P.light, marginLeft: 6 }}>
              {selected.project_name}
            </span>
          )}
          {!disabled && (
            <button type="button" onClick={clear} aria-label="Clear planting selection" style={chipClearBtn}>
              ✕
            </button>
          )}
        </div>
        {!disabled && (
          <button
            type="button"
            onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0) }}
            style={linkBtn}
          >
            Change
          </button>
        )}
      </div>
    )
  }

  const showBlankError = required && touched && !selected && !query
  const effectivePlaceholder = disabled && disabledHint
    ? disabledHint
    : (placeholder ?? EMPTY_PLACEHOLDER[emptyMeaning] ?? EMPTY_PLACEHOLDER.unset)

  return (
    <div style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-required={required || undefined}
        aria-invalid={showBlankError || undefined}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        data-testid={dataTestId}
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => { if (!disabled) setOpen(true) }}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        placeholder={effectivePlaceholder}
        disabled={disabled}
        style={{ ...inputChrome(showBlankError), minHeight: 44, ...(disabled ? { opacity: 0.5, cursor: 'not-allowed' } : null) }}
        autoComplete="off"
      />
      {open && !disabled && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Plantings"
          style={listboxStyle}
          // Keep input focus while clicking rows; onBlur's deferred close still runs after click.
          onMouseDown={e => e.preventDefault()}
        >
          {loading && <li style={noteRow} role="presentation">Loading plantings…</li>}
          {failed && !loading && (
            <li style={noteRow} role="presentation">
              Couldn’t load your plantings — you can still save without one.
            </li>
          )}
          {!loading && !failed && visible.length === 0 && (
            <li style={noteRow} role="presentation">
              {query.trim() ? `No plantings match “${query.trim()}”.` : 'No plantings yet.'}
            </li>
          )}
          {visible.map((p, i) => (
            <li
              key={p.id}
              role="option"
              aria-selected={String(p.id) === String(value)}
              data-testid={`ps-opt-${p.id}`}
              onClick={() => select(p)}
              style={rowStyle(i === highlight)}
            >
              <span>{label(p)}</span>
              {/* V4-PROJHIDE-001: option project_name tag hidden when projects aren't user-facing.
                  V4-PICKERUX-001: also hidden when every visible row shares one project. */}
              {p.project_name && labelFormat !== 'wave' && !PROJECTS_HIDDEN && showProjectTag && (
                <span style={{ fontSize: '0.74rem', color: P.light, marginLeft: 8 }}>{p.project_name}</span>
              )}
            </li>
          ))}
          {hiddenCount > 0 && (
            <li style={noteRow} role="presentation">
              +{hiddenCount} more — keep typing to narrow.
            </li>
          )}
        </ul>
      )}
      {showBlankError && (
        <div role="alert" style={{ color: P.terra, fontSize: '0.77rem', marginTop: 4 }}>
          Choose a planting.
        </div>
      )}
    </div>
  )
}

// ── Chrome (composed from P/T per formStyles discipline — no raw hex) ────────
function chipStyle(disabled) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    backgroundColor: P.greenPale,
    border: `1px solid ${P.green}`,
    borderRadius: T.radiusField,
    padding: '8px 10px',
    minHeight: 44,
    boxSizing: 'border-box',
    opacity: disabled ? 0.6 : 1,
  }
}

const chipClearBtn = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: P.mid,
  fontSize: '0.9rem',
  padding: '4px 6px',
  minWidth: 30,
  minHeight: 30,
  lineHeight: 1,
}

const linkBtn = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: P.green,
  fontSize: '0.82rem',
  fontWeight: 600,
  textDecoration: 'underline',
  padding: '8px 6px',
  minHeight: 44,
}

const listboxStyle = {
  position: 'absolute',
  zIndex: 30,
  top: '100%',
  left: 0,
  right: 0,
  margin: '4px 0 0',
  padding: 4,
  listStyle: 'none',
  backgroundColor: P.white,
  border: `1px solid ${P.border}`,
  borderRadius: T.radiusField,
  boxShadow: '0 6px 18px rgba(0,0,0,0.12)',
  maxHeight: 280,
  overflowY: 'auto',
}

function rowStyle(highlighted) {
  return {
    display: 'flex',
    alignItems: 'baseline',
    padding: '11px 10px',
    minHeight: 44,
    boxSizing: 'border-box',
    borderRadius: 5,
    cursor: 'pointer',
    fontSize: '0.88rem',
    color: P.dark,
    backgroundColor: highlighted ? P.greenPale : 'transparent',
  }
}

const noteRow = {
  padding: '10px',
  fontSize: '0.8rem',
  color: P.light,
}

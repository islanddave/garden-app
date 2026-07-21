// VarietyPicker — inline search-as-you-type picker for plant_varieties.
// Controlled component: parent owns variety_id via { value, onChange }.
//
// Props:
//   value:           variety object or null (current selection — parent state)
//   onChange:        (variety|null) => void
//   allowCreate:     boolean (default true) — show "Create '<query>'" footer
//   speciesFilter:   string|undefined — restrict create payload to this species
//   required:        boolean — adds aria-required, shows red error border if blank on blur
//   disabled:        boolean
//   placeholder:     string (default: 'Search varieties…')
//   id:              string — for label htmlFor association
//
// Behavior:
//   - 250ms debounce on search input → useVarieties().search(q)
//   - Empty result + allowCreate → "Create '<query>'" footer item
//   - 409 fuzzy-match → modal: Use existing | Create anyway (allowDuplicate:true) | Cancel
//   - Keyboard: ↑/↓ navigate; Enter selects highlighted (or creates if footer); Esc closes
//   - ADHD-friendly: clear empty/primer/error states; "Selected: X" chip after pick
//
// Schema field reference (plant_varieties): id, name, species, common_name, source, notes.
// CHECK constraint chk_inventory_seed_requires_variety enforces inventory category=seeds → variety_id NOT NULL.

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useVarieties } from '../hooks/useVarieties.js'
import { useCropTypes } from '../hooks/useCropTypes.js'
import { P } from '../lib/constants.js'

const DEBOUNCE_MS = 250

// V4-CROPTYPE-001 — mirrors the crop_types.default_lifecycle CHECK (and VALID_LIFECYCLE in
// lambda/varieties/validate.js). Duplicated rather than imported because src/ must not reach into
// lambda/; the server re-validates, so a drift here is a 400, never a bad row.
const LIFECYCLE_OPTIONS = [
  ['annual', 'Annual'],
  ['tender_perennial', 'Tender perennial'],
  ['perennial', 'Perennial'],
  ['biennial', 'Biennial'],
]

// Max rows rendered in the listbox. Was a hard 50, which SILENTLY truncated: with 398 live
// varieties the browse list died in the C's, and even crop-scoped `pepper` is 107. Raised, and
// truncation is now VISIBLE (footer below) so a capped list can never again read as "that's all".
const MAX_RESULTS = 200

export default function VarietyPicker({
  value = null,
  onChange,
  allowCreate = true,
  speciesFilter,
  // Optional crop scoping (V4-HARVESTCENTER-001): when set, only varieties of that crop_type_slug
  // are offered — e.g. Put-Up picks "pepper" so you choose Jalapeño vs Habanero, not all 398.
  // Undefined (every other consumer) = unchanged behaviour.
  cropSlugFilter,
  required = false,
  disabled = false,
  placeholder = 'Search varieties…',
  id,
}) {
  const { varieties, loading, error, search, createVariety } = useVarieties()
  const { cropTypes, createCropType } = useCropTypes()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState(null)
  const [touched, setTouched] = useState(false)
  // V4-PLANTTYPE-001: two-stage create. null = picking/creating a variety; 'crop' = the
  // crop-type chooser shown after the user commits to creating a brand-new variety, so new
  // varieties get typed at authoring time (controlled crop_types vocab). Optional — a
  // "No crop type" row keeps creation possible, and an empty vocab skips the stage entirely.
  // V4-CROPTYPE-001 adds a third stage: 'newcrop' = the inline mint-a-crop-type form, reached from
  // the last row of the 'crop' stage. Before this, the vocabulary was closed from the app, so a
  // plant with no matching type could only be saved as "No crop type" — which drops it out of
  // every type-grouped view (the reason this was reprioritised).
  const [createStage, setCreateStage] = useState(null)
  const [newCropName, setNewCropName] = useState('')
  const [newCropCategory, setNewCropCategory] = useState('')
  const [newCropLifecycle, setNewCropLifecycle] = useState('')
  const [creatingCrop, setCreatingCrop] = useState(false)
  // null | { message, existing }. `existing` present = the server steered us to a type that
  // already covers this name; the UI offers adopting it rather than treating it as an error.
  const [cropErr, setCropErr] = useState(null)
  // Disambiguation modal state for 409 conflict
  // null | { query, existing }
  const [conflict, setConflict] = useState(null)

  const inputRef = useRef(null)
  const listboxId = useMemo(() => `vp-list-${Math.random().toString(36).slice(2, 9)}`, [])
  const debounceRef = useRef(null)
  const lastSentRef = useRef('')
  // Crop chosen for the in-flight create, so a 409 "Create anyway" re-submits with the same type.
  const pendingCropRef = useRef({ slug: null, lifecycle: null })

  // Category options are DERIVED from the live vocabulary rather than hardcoded, so the picker
  // can never offer a category the server would reject — the server's allowlist is exactly the
  // set already in use. Falls back to the lifecycle-free 'none' choice if the vocab is empty.
  const categoryOptions = useMemo(
    () => [...new Set(cropTypes.map(c => c.category).filter(Boolean))].sort(),
    [cropTypes],
  )

  // slug -> crop_type row, for labelling existing varieties + the selected chip.
  const cropBySlug = useMemo(() => {
    const m = {}
    for (const c of cropTypes) m[c.slug] = c
    return m
  }, [cropTypes])
  const cropLabel = useCallback((slug) => (slug && cropBySlug[slug]?.display_name) || null, [cropBySlug])

  // ── Debounced search ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = query.trim()
    debounceRef.current = setTimeout(() => {
      if (q === lastSentRef.current) return
      lastSentRef.current = q
      search(q || null)
    }, DEBOUNCE_MS)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query, open, search])

  // Reset highlight whenever results change or we switch create stage
  useEffect(() => { setHighlight(0) }, [varieties, query, createStage])

  // ── Filtered list (server already filtered by ?q=; this is a defensive client filter) ──
  // `matched` is the FULL match set; `filtered` is what we render (capped at MAX_RESULTS). Keeping
  // both lets the listbox tell the user when there is more, instead of truncating silently.
  const matched = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = varieties
    if (speciesFilter) list = list.filter(v => v.species === speciesFilter)
    if (cropSlugFilter) list = list.filter(v => v.crop_type_slug === cropSlugFilter)
    const byName = (a, b) => (a.name || '').localeCompare(b.name || '')
    if (!q) return [...list].sort(byName)
    return list.filter(v => {
      const name = (v.name || '').toLowerCase()
      const sp = (v.species || '').toLowerCase()
      const cn = (v.common_name || '').toLowerCase()
      return name.includes(q) || sp.includes(q) || cn.includes(q)
    }).sort(byName)
  }, [varieties, query, speciesFilter, cropSlugFilter])

  const filtered = useMemo(() => matched.slice(0, MAX_RESULTS), [matched])
  const hiddenCount = matched.length - filtered.length

  const showCreateFooter = allowCreate && query.trim().length > 0 && !filtered.some(v =>
    (v.name || '').toLowerCase() === query.trim().toLowerCase()
  )

  // total focusable items = filtered.length + (1 if create footer)
  const itemCount = filtered.length + (showCreateFooter ? 1 : 0)
  // In the crop stage: row 0 = "No crop type", rows 1..N = crop types, row N+1 = "New crop type…".
  const cropItemCount = cropTypes.length + 2
  const newCropRowIndex = cropTypes.length + 1

  // ── Selection handlers ────────────────────────────────────────────────────
  const selectVariety = useCallback((v) => {
    onChange?.(v)
    setOpen(false)
    setQuery('')
    setCreateErr(null)
    setCreateStage(null)
    setTouched(true)
  }, [onChange])

  const clearSelection = useCallback(() => {
    onChange?.(null)
    setTouched(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [onChange])

  const submitCreate = useCallback(async (allowDuplicate = false, cropSlug = null, cropLifecycle = null) => {
    const name = query.trim()
    if (!name) return
    // Remember the chosen crop so a 409 "Create anyway" re-submits with the same type.
    if (!allowDuplicate) pendingCropRef.current = { slug: cropSlug, lifecycle: cropLifecycle }
    const crop = allowDuplicate ? pendingCropRef.current : { slug: cropSlug, lifecycle: cropLifecycle }
    setCreating(true)
    setCreateErr(null)
    const payload = { name }
    if (speciesFilter) payload.species = speciesFilter
    if (crop.slug) {
      payload.crop_type_slug = crop.slug
      if (crop.lifecycle) payload.lifecycle = crop.lifecycle
    }
    const res = await createVariety(payload, { allowDuplicate })
    setCreating(false)
    if (res.error && res.existing && !allowDuplicate) {
      setConflict({ query: name, existing: res.existing })
      return
    }
    if (res.error) {
      setCreateErr(res.error)
      return
    }
    selectVariety(res.variety)
    setConflict(null)
  }, [query, speciesFilter, createVariety, selectVariety])

  // Commit to creating a new variety: enter the crop-type chooser, or (no vocab) create directly.
  const beginCreate = useCallback(() => {
    if (cropTypes.length > 0) { setCreateStage('crop'); setHighlight(0) }
    else submitCreate(false)
  }, [cropTypes.length, submitCreate])

  // Open the mint-a-crop-type form. Deliberately does NOT prefill from `query`: `query` is the
  // VARIETY name ("Mahogany Splendor") and the crop type is its parent ("Hibiscus") — prefilling
  // would invite a one-variety-per-type vocabulary, which is the fragmentation this guards against.
  const beginNewCropType = useCallback(() => {
    setCropErr(null)
    setNewCropName('')
    setNewCropCategory('')
    setNewCropLifecycle('')
    setCreateStage('newcrop')
  }, [])

  // Create the crop type, then immediately continue the variety create with it — the user asked
  // for a variety, so stopping at "type created" would strand them mid-flow.
  const submitNewCropType = useCallback(async () => {
    const display_name = newCropName.trim()
    if (!display_name || creatingCrop) return
    setCreatingCrop(true)
    setCropErr(null)
    const res = await createCropType({
      display_name,
      category: newCropCategory || null,
      default_lifecycle: newCropLifecycle || null,
    })
    setCreatingCrop(false)
    if (res.error) {
      setCropErr({ message: res.error, existing: res.existing ?? null })
      return
    }
    setCreateStage(null)
    submitCreate(false, res.cropType.slug, res.cropType.default_lifecycle ?? null)
  }, [newCropName, newCropCategory, newCropLifecycle, creatingCrop, createCropType, submitCreate])

  // "Use <existing>" after the server steered us — continues the variety create with the type
  // that already exists, which is the whole point of steering rather than hard-failing.
  const adoptSteeredCropType = useCallback(() => {
    const ex = cropErr?.existing
    if (!ex) return
    setCropErr(null)
    setCreateStage(null)
    submitCreate(false, ex.slug, ex.default_lifecycle ?? null)
  }, [cropErr, submitCreate])

  // ── Keyboard nav ──────────────────────────────────────────────────────────
  const onKeyDown = (e) => {
    if (disabled) return
    // The 'newcrop' form owns its own inputs; only Escape is handled here (back to the chooser).
    // Enter is NOT intercepted — it must reach the form's own submit.
    if (createStage === 'newcrop') {
      if (e.key === 'Escape') { e.preventDefault(); setCropErr(null); setCreateStage('crop'); setHighlight(0) }
      return
    }
    if (createStage === 'crop') {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(cropItemCount - 1, h + 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(0, h - 1)) }
      else if (e.key === 'Enter') {
        e.preventDefault()
        if (highlight === 0) submitCreate(false, null, null)
        else if (highlight === newCropRowIndex) beginNewCropType()
        else { const ct = cropTypes[highlight - 1]; if (ct) submitCreate(false, ct.slug, ct.default_lifecycle ?? null) }
      } else if (e.key === 'Escape') { e.preventDefault(); setCreateStage(null) }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      setHighlight(h => Math.min(itemCount - 1, h + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(h => Math.max(0, h - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      if (highlight < filtered.length) {
        selectVariety(filtered[highlight])
      } else if (showCreateFooter) {
        beginCreate()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      inputRef.current?.blur()
    }
  }

  const onFocus = () => { if (!disabled) setOpen(true) }
  const onBlur = () => {
    // Delay close so a click on the listbox (which preventDefaults mousedown to keep input
    // focus) lands first. A real blur — e.g. tabbing away — still closes the dropdown.
    setTimeout(() => setOpen(false), 150)
    setTouched(true)
  }

  // ── Render: selected chip mode (compact) ──────────────────────────────────
  if (value && !open) {
    const cl = cropLabel(value.crop_type_slug)
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={chipStyle(disabled)} aria-live="polite">
          <span style={{ fontSize: '0.88rem', fontWeight: 600, color: P.green }}>
            {value.name}
          </span>
          {cl && (
            <span style={cropTagStyle} title="Crop type">{cl}</span>
          )}
          {value.species && (
            <span style={{ fontSize: '0.74rem', color: P.light, marginLeft: 6 }}>
              {value.species}
            </span>
          )}
          {!disabled && (
            <button
              type="button"
              onClick={clearSelection}
              aria-label="Clear variety selection"
              style={chipClearBtn}
            >
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

  // ── Render: search mode ───────────────────────────────────────────────────
  const showBlankError = required && touched && !value && !query
  const hasError = !!createErr || showBlankError

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
        aria-invalid={hasError || undefined}
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); setCreateErr(null); setCreateStage(null) }}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        style={inputStyle(hasError, disabled)}
        autoComplete="off"
      />

      {/* V4-CROPTYPE-001 — mint-a-crop-type form. Rendered INSTEAD of the listbox (not inside it):
          a role="listbox" may only contain options, so nesting inputs here would be invalid ARIA
          and would break the combobox for screen readers. Deliberately does NOT preventDefault on
          mousedown the way the list does — these fields need to take focus. */}
      {open && !disabled && createStage === 'newcrop' && (
        <div style={formPanelStyle}>
          <div style={{ ...cropHeaderRow, borderBottom: 'none', padding: '0 0 8px' }}>
            New crop type{query.trim() ? <> for <strong>"{query.trim()}"</strong></> : null}
          </div>

          <label style={fieldLabelStyle} htmlFor={`${listboxId}-ncname`}>Name</label>
          <input
            id={`${listboxId}-ncname`}
            autoFocus
            type="text"
            value={newCropName}
            onChange={e => { setNewCropName(e.target.value); setCropErr(null) }}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); submitNewCropType() }
              if (e.key === 'Escape') { e.preventDefault(); setCropErr(null); setCreateStage('crop'); setHighlight(0) }
            }}
            placeholder="e.g. Hibiscus"
            style={inputStyle(false, false)}
            autoComplete="off"
          />

          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={fieldLabelStyle} htmlFor={`${listboxId}-nccat`}>Category</label>
              <select
                id={`${listboxId}-nccat`}
                value={newCropCategory}
                onChange={e => setNewCropCategory(e.target.value)}
                style={inputStyle(false, false)}
              >
                <option value="">— none —</option>
                {categoryOptions.map(c => (
                  <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={fieldLabelStyle} htmlFor={`${listboxId}-nclc`}>Lifecycle</label>
              <select
                id={`${listboxId}-nclc`}
                value={newCropLifecycle}
                onChange={e => setNewCropLifecycle(e.target.value)}
                style={inputStyle(false, false)}
              >
                <option value="">— none —</option>
                {LIFECYCLE_OPTIONS.map(([v, label]) => (
                  <option key={v} value={v}>{label}</option>
                ))}
              </select>
            </div>
          </div>

          {cropErr && (
            <div style={{ ...errorRow, padding: '10px 0 0' }}>
              <div>{cropErr.message}</div>
              {/* The server steered us to an existing type. Adopting it is the CORRECT outcome —
                  especially for a coupled crop, where a duplicate type silently loses its derived
                  facets — so it gets a real button, not just an error string. */}
              {cropErr.existing && (
                <button
                  type="button"
                  onClick={adoptSteeredCropType}
                  style={adoptButtonStyle}
                >
                  Use "{cropErr.existing.display_name}"
                </button>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              type="button"
              onClick={submitNewCropType}
              disabled={!newCropName.trim() || creatingCrop}
              style={primaryButtonStyle(!newCropName.trim() || creatingCrop)}
            >
              {creatingCrop ? 'Creating…' : 'Create crop type'}
            </button>
            <button
              type="button"
              onClick={() => { setCropErr(null); setCreateStage('crop'); setHighlight(0) }}
              style={secondaryButtonStyle}
            >
              Back
            </button>
          </div>
        </div>
      )}

      {open && !disabled && createStage !== 'newcrop' && (
        <ul
          id={listboxId}
          role="listbox"
          style={listStyle}
          onMouseDown={e => e.preventDefault() /* keep focus on input */}
        >
          {createStage === 'crop' ? (
            <>
              <li style={cropHeaderRow} aria-hidden="true">
                Crop type for <strong>"{query.trim()}"</strong>
              </li>
              <li
                role="option"
                aria-selected={highlight === 0}
                onClick={() => submitCreate(false, null, null)}
                onMouseEnter={() => setHighlight(0)}
                style={rowStyle(highlight === 0)}
              >
                <span style={{ color: P.light, fontStyle: 'italic', fontSize: '0.88rem' }}>
                  — No crop type —
                </span>
              </li>
              {cropTypes.map((ct, i) => (
                <li
                  key={ct.slug}
                  role="option"
                  aria-selected={highlight === i + 1}
                  onClick={() => submitCreate(false, ct.slug, ct.default_lifecycle ?? null)}
                  onMouseEnter={() => setHighlight(i + 1)}
                  style={rowStyle(highlight === i + 1)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                    <span style={{ fontWeight: 600, color: P.dark, fontSize: '0.9rem' }}>{ct.display_name}</span>
                    {ct.category && (
                      <span style={{ fontSize: '0.7rem', color: P.light, textTransform: 'capitalize' }}>{ct.category}</span>
                    )}
                  </div>
                </li>
              ))}
              <li
                role="option"
                aria-selected={highlight === newCropRowIndex}
                onClick={beginNewCropType}
                onMouseEnter={() => setHighlight(newCropRowIndex)}
                style={createRowStyle(highlight === newCropRowIndex, false)}
              >
                ＋ New crop type…
              </li>
              {creating && <li style={primerRow}>Creating "{query.trim()}"…</li>}
            </>
          ) : (
            <>
              {loading && (
                <li style={primerRow}>Loading varieties…</li>
              )}
              {!loading && error && (
                <li style={errorRow}>Couldn't load varieties — {error}</li>
              )}
              {!loading && !error && filtered.length === 0 && !showCreateFooter && (
                <li style={primerRow}>
                  {query.trim() ? 'No varieties match.' : 'Start typing to search varieties.'}
                </li>
              )}
              {!loading && filtered.map((v, i) => {
                const cl = cropLabel(v.crop_type_slug)
                return (
                  <li
                    key={v.id}
                    role="option"
                    aria-selected={highlight === i}
                    onClick={() => selectVariety(v)}
                    onMouseEnter={() => setHighlight(i)}
                    style={rowStyle(highlight === i)}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontWeight: 600, color: P.dark, fontSize: '0.9rem' }}>
                        {v.name}
                        {cl && <span style={cropTagStyle} title="Crop type">{cl}</span>}
                      </span>
                      {(v.species || v.common_name) && (
                        <span style={{ fontSize: '0.74rem', color: P.light }}>
                          {[v.common_name, v.species].filter(Boolean).join(' • ')}
                        </span>
                      )}
                    </div>
                  </li>
                )
              })}
              {/* Truncation is VISIBLE, never silent (the old hard 50-cap just cut the list off
                  mid-alphabet with no indication). Not a role=option — it is not selectable and
                  must stay out of the listbox's focusable item count. */}
              {!loading && hiddenCount > 0 && (
                <li role="presentation" style={{ padding: '8px 12px', fontSize: '0.78rem', color: P.mid,
                  borderTop: `1px solid ${P.border}`, background: P.cream }}>
                  Showing {filtered.length} of {matched.length} — keep typing to narrow.
                </li>
              )}
              {showCreateFooter && !loading && (
                <li
                  role="option"
                  aria-selected={highlight === filtered.length}
                  onClick={() => beginCreate()}
                  onMouseEnter={() => setHighlight(filtered.length)}
                  style={createRowStyle(highlight === filtered.length, creating)}
                >
                  {creating ? (
                    <span>Creating "{query.trim()}"…</span>
                  ) : (
                    <>
                      <span style={{ fontSize: '0.95rem' }}>＋</span>
                      <span style={{ marginLeft: 8 }}>
                        Create <strong>"{query.trim()}"</strong>
                      </span>
                    </>
                  )}
                </li>
              )}
            </>
          )}
        </ul>
      )}

      {createErr && (
        <div role="alert" style={errorBanner}>
          ⚠ {createErr}
        </div>
      )}

      {showBlankError && (
        <div role="alert" style={errorBanner}>
          ⚠ Please pick or create a variety.
        </div>
      )}

      {conflict && (
        <ConflictModal
          query={conflict.query}
          existing={conflict.existing}
          onUseExisting={() => { selectVariety(conflict.existing); setConflict(null) }}
          onCreateAnyway={() => submitCreate(true)}
          onCancel={() => setConflict(null)}
          creating={creating}
        />
      )}
    </div>
  )
}

// ── ConflictModal ────────────────────────────────────────────────────────────
function ConflictModal({ query, existing, onUseExisting, onCreateAnyway, onCancel, creating }) {
  // Esc closes
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="vp-conflict-title" style={modalBackdrop}>
      <div style={modalCard}>
        <h2 id="vp-conflict-title" style={{ margin: '0 0 8px', fontSize: '1.05rem', color: P.green }}>
          Similar variety already exists
        </h2>
        <p style={{ margin: '0 0 14px', fontSize: '0.9rem', color: P.mid }}>
          You're creating <strong>"{query}"</strong>. We found a close match:
        </p>
        <div style={existingCard}>
          <div style={{ fontWeight: 700, color: P.dark, fontSize: '0.95rem' }}>{existing.name}</div>
          {(existing.species || existing.common_name) && (
            <div style={{ fontSize: '0.78rem', color: P.light, marginTop: 2 }}>
              {[existing.common_name, existing.species].filter(Boolean).join(' • ')}
            </div>
          )}
          {existing.source && (
            <div style={{ fontSize: '0.78rem', color: P.light, marginTop: 2 }}>
              Source: {existing.source}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" onClick={onUseExisting} disabled={creating} style={btnPrimary(creating)}>
            Use existing
          </button>
          <button type="button" onClick={onCreateAnyway} disabled={creating} style={btnSecondary(creating)}>
            {creating ? 'Creating…' : 'Create anyway'}
          </button>
          <button type="button" onClick={onCancel} disabled={creating} style={btnGhost(creating)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Styles (inline, matches InventoryAdd.jsx pattern using P palette) ────────
const inputStyle = (hasErr, disabled) => ({
  width: '100%',
  padding: '10px 12px',
  border: `1px solid ${hasErr ? P.terra : P.border}`,
  borderRadius: 7,
  fontSize: '0.9rem',
  backgroundColor: disabled ? '#f3eee9' : P.white,
  boxSizing: 'border-box',
  fontFamily: 'inherit',
  cursor: disabled ? 'not-allowed' : 'text',
  minHeight: 44, // mobile-tap-friendly
})

const listStyle = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  left: 0,
  right: 0,
  zIndex: 50,
  margin: 0,
  padding: 0,
  listStyle: 'none',
  backgroundColor: P.white,
  border: `1px solid ${P.border}`,
  borderRadius: 8,
  boxShadow: '0 6px 22px rgba(0,0,0,0.12)',
  maxHeight: 280,
  overflowY: 'auto',
}

const rowStyle = (active) => ({
  padding: '10px 12px',
  cursor: 'pointer',
  backgroundColor: active ? P.greenPale : 'transparent',
  borderBottom: `1px solid ${P.cream}`,
  minHeight: 48,
  display: 'flex',
  alignItems: 'center',
})

const createRowStyle = (active, busy) => ({
  padding: '12px',
  cursor: busy ? 'wait' : 'pointer',
  backgroundColor: active ? P.greenPale : '#fbf8f3',
  borderTop: `1px solid ${P.border}`,
  color: P.green,
  fontSize: '0.9rem',
  display: 'flex',
  alignItems: 'center',
  fontWeight: 600,
  minHeight: 48,
})

// V4-CROPTYPE-001 mint-a-crop-type panel. Same anchoring/elevation as the listbox so it reads as
// the same surface, but a plain container (no listStyle overflow) since it holds form controls.
const formPanelStyle = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  left: 0,
  right: 0,
  zIndex: 50,
  padding: 12,
  backgroundColor: P.white,
  border: `1px solid ${P.border}`,
  borderRadius: 8,
  boxShadow: '0 6px 22px rgba(0,0,0,0.12)',
  boxSizing: 'border-box',
}

const fieldLabelStyle = {
  display: 'block',
  fontSize: '0.72rem',
  fontWeight: 700,
  color: P.mid,
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
  marginBottom: 4,
}

const primaryButtonStyle = (isDisabled) => ({
  flex: 1,
  padding: '10px 12px',
  minHeight: 44,
  borderRadius: 7,
  border: 'none',
  backgroundColor: isDisabled ? P.border : P.green,
  color: isDisabled ? P.light : P.white,
  fontSize: '0.88rem',
  fontWeight: 700,
  fontFamily: 'inherit',
  cursor: isDisabled ? 'not-allowed' : 'pointer',
})

const secondaryButtonStyle = {
  padding: '10px 14px',
  minHeight: 44,
  borderRadius: 7,
  border: `1px solid ${P.border}`,
  backgroundColor: P.white,
  color: P.mid,
  fontSize: '0.88rem',
  fontFamily: 'inherit',
  cursor: 'pointer',
}

const adoptButtonStyle = {
  marginTop: 8,
  padding: '8px 12px',
  minHeight: 40,
  borderRadius: 7,
  border: `1px solid ${P.green}`,
  backgroundColor: P.greenPale,
  color: P.green,
  fontSize: '0.85rem',
  fontWeight: 700,
  fontFamily: 'inherit',
  cursor: 'pointer',
}

const cropHeaderRow = {
  padding: '10px 12px 6px',
  color: P.mid,
  fontSize: '0.8rem',
  borderBottom: `1px solid ${P.cream}`,
  backgroundColor: '#fbf8f3',
}

const cropTagStyle = {
  display: 'inline-block',
  marginLeft: 8,
  padding: '1px 7px',
  borderRadius: 999,
  backgroundColor: P.greenPale,
  color: P.green,
  fontSize: '0.66rem',
  fontWeight: 700,
  verticalAlign: 'middle',
  textTransform: 'capitalize',
}

const primerRow = {
  padding: '14px 12px',
  color: P.light,
  fontSize: '0.85rem',
  fontStyle: 'italic',
}

const errorRow = {
  padding: '14px 12px',
  color: P.terra,
  fontSize: '0.85rem',
}

const errorBanner = {
  marginTop: 6,
  fontSize: '0.78rem',
  color: P.terra,
  display: 'flex',
  alignItems: 'center',
  gap: 4,
}

const chipStyle = (disabled) => ({
  display: 'inline-flex',
  alignItems: 'center',
  padding: '8px 12px',
  border: `1px solid ${P.border}`,
  borderRadius: 999,
  backgroundColor: disabled ? '#f3eee9' : P.greenPale,
  maxWidth: '100%',
})

const chipClearBtn = {
  background: 'none',
  border: 'none',
  color: P.mid,
  cursor: 'pointer',
  fontSize: '0.85rem',
  marginLeft: 8,
  padding: 0,
  lineHeight: 1,
}

const linkBtn = {
  background: 'none',
  border: 'none',
  color: P.green,
  cursor: 'pointer',
  fontSize: '0.85rem',
  textDecoration: 'underline',
  padding: 0,
}

// Modal styles
const modalBackdrop = {
  position: 'fixed',
  inset: 0,
  backgroundColor: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'center',
  zIndex: 1000,
  padding: 16,
}

const modalCard = {
  backgroundColor: P.white,
  borderRadius: 12,
  padding: '20px 18px 18px',
  maxWidth: 460,
  width: '100%',
  boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
  // Mobile-sheet feel: full-width, bottom-anchored on small screens
  marginBottom: 'env(safe-area-inset-bottom, 0)',
}

const existingCard = {
  border: `1px solid ${P.border}`,
  borderRadius: 8,
  padding: '10px 12px',
  marginBottom: 16,
  backgroundColor: P.cream,
}

const btnPrimary = (disabled) => ({
  backgroundColor: disabled ? P.light : P.green,
  color: P.white,
  border: 'none',
  borderRadius: 7,
  padding: '10px 18px',
  fontSize: '0.88rem',
  fontWeight: 700,
  cursor: disabled ? 'not-allowed' : 'pointer',
  minHeight: 44,
})

const btnSecondary = (disabled) => ({
  backgroundColor: 'transparent',
  color: P.terra,
  border: `1px solid ${P.terra}`,
  borderRadius: 7,
  padding: '10px 18px',
  fontSize: '0.88rem',
  fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
  minHeight: 44,
})

const btnGhost = (disabled) => ({
  backgroundColor: 'transparent',
  color: P.mid,
  border: 'none',
  borderRadius: 7,
  padding: '10px 14px',
  fontSize: '0.88rem',
  cursor: disabled ? 'not-allowed' : 'pointer',
  minHeight: 44,
})

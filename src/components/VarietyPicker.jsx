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
import { P } from '../lib/constants.js'

const DEBOUNCE_MS = 250

export default function VarietyPicker({
  value = null,
  onChange,
  allowCreate = true,
  speciesFilter,
  required = false,
  disabled = false,
  placeholder = 'Search varieties…',
  id,
}) {
  const { varieties, loading, error, search, createVariety } = useVarieties()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState(null)
  const [touched, setTouched] = useState(false)
  // Disambiguation modal state for 409 conflict
  // null | { query, existing }
  const [conflict, setConflict] = useState(null)

  const inputRef = useRef(null)
  const listboxId = useMemo(() => `vp-list-${Math.random().toString(36).slice(2, 9)}`, [])
  const debounceRef = useRef(null)
  const lastSentRef = useRef('')

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

  // Reset highlight whenever results change
  useEffect(() => { setHighlight(0) }, [varieties, query])

  // ── Filtered list (server already filtered by ?q=; this is a defensive client filter) ──
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = varieties
    if (speciesFilter) list = list.filter(v => v.species === speciesFilter)
    if (!q) return list.slice(0, 50)
    return list.filter(v => {
      const name = (v.name || '').toLowerCase()
      const sp = (v.species || '').toLowerCase()
      const cn = (v.common_name || '').toLowerCase()
      return name.includes(q) || sp.includes(q) || cn.includes(q)
    }).slice(0, 50)
  }, [varieties, query, speciesFilter])

  const showCreateFooter = allowCreate && query.trim().length > 0 && !filtered.some(v =>
    (v.name || '').toLowerCase() === query.trim().toLowerCase()
  )

  // total focusable items = filtered.length + (1 if create footer)
  const itemCount = filtered.length + (showCreateFooter ? 1 : 0)

  // ── Selection handlers ────────────────────────────────────────────────────
  const selectVariety = useCallback((v) => {
    onChange?.(v)
    setOpen(false)
    setQuery('')
    setCreateErr(null)
    setTouched(true)
  }, [onChange])

  const clearSelection = useCallback(() => {
    onChange?.(null)
    setTouched(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [onChange])

  const submitCreate = useCallback(async (allowDuplicate = false) => {
    const name = query.trim()
    if (!name) return
    setCreating(true)
    setCreateErr(null)
    const payload = { name }
    if (speciesFilter) payload.species = speciesFilter
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

  // ── Keyboard nav ──────────────────────────────────────────────────────────
  const onKeyDown = (e) => {
    if (disabled) return
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
        submitCreate(false)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      inputRef.current?.blur()
    }
  }

  const onFocus = () => { if (!disabled) setOpen(true) }
  const onBlur = () => {
    // Delay close so click on listbox lands first
    setTimeout(() => setOpen(false), 150)
    setTouched(true)
  }

  // ── Render: selected chip mode (compact) ──────────────────────────────────
  if (value && !open) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={chipStyle(disabled)} aria-live="polite">
          <span style={{ fontSize: '0.88rem', fontWeight: 600, color: P.green }}>
            {value.name}
          </span>
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
        onChange={e => { setQuery(e.target.value); setOpen(true); setCreateErr(null) }}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        style={inputStyle(hasError, disabled)}
        autoComplete="off"
      />

      {open && !disabled && (
        <ul
          id={listboxId}
          role="listbox"
          style={listStyle}
          onMouseDown={e => e.preventDefault() /* keep focus on input */}
        >
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
          {!loading && filtered.map((v, i) => (
            <li
              key={v.id}
              role="option"
              aria-selected={highlight === i}
              onClick={() => selectVariety(v)}
              onMouseEnter={() => setHighlight(i)}
              style={rowStyle(highlight === i)}
            >
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontWeight: 600, color: P.dark, fontSize: '0.9rem' }}>{v.name}</span>
                {(v.species || v.common_name) && (
                  <span style={{ fontSize: '0.74rem', color: P.light }}>
                    {[v.common_name, v.species].filter(Boolean).join(' • ')}
                  </span>
                )}
              </div>
            </li>
          ))}
          {showCreateFooter && !loading && (
            <li
              role="option"
              aria-selected={highlight === filtered.length}
              onClick={() => submitCreate(false)}
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

// src/components/forms/ChoiceGrid.jsx
// V4-FORMSYS-CHOICEGRID-001 — canonical single-select card/list picker. Replaces the bespoke
// TypeCard (InventoryAdd) + ZoneCard (ZonePicker, since deleted) selectors with ONE grammar:
// selected = greenPale fill + green 2px border + check; error = terra border. Two layouts preserve
// current looks: 'grid' (icon over label, N columns — InventoryAdd) | 'list' (icon left,
// label+description, check right, full-width — originally ZonePicker, now OverwinterPrompt/AddSeeds;
// the layout outlived the page). Real radio semantics: role=radiogroup/radio + aria-checked
// + roving tabindex + arrow-key nav (the bespoke originals were plain buttons with no a11y).
//
// V4-ICON-001. An option carries its mark as `iconName` — a REGISTRY KEY this component resolves —
// rather than as a glyph the caller interpolates. Two data modules (overwinterRegimes, inventoryEnums)
// held emoji purely because their only render site was this one line, and a key that arrives as a
// string can be checked by a static test; an emoji baked into a data module cannot. The legacy
// `icon` field still works and still takes a node: AddSeeds passes ready-made <Icon> elements, and
// ChoiceGrid.test.jsx passes plain strings. Both paths are live, so neither is a migration remnant.
import React, { useRef } from 'react'
import { P } from '../../lib/constants.js'
import Icon from '../Icon.jsx'

function cardStyle({ selected, hasError, layout }) {
  const base = {
    border: `2px solid ${selected ? P.green : hasError ? P.terra : P.border}`,
    borderRadius: layout === 'list' ? 12 : 10,
    backgroundColor: selected ? P.greenPale : P.white,
    cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.12s', boxSizing: 'border-box',
  }
  if (layout === 'list') return { ...base, display: 'flex', alignItems: 'center', gap: 16, width: '100%', minHeight: 80, padding: '16px 20px', textAlign: 'left' }
  return { ...base, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, minHeight: 90, padding: '16px 12px', textAlign: 'center' }
}

export default function ChoiceGrid({ value, onChange, options = [], columns = 2, layout = 'grid', error, ariaLabel, style, ...rest }) {
  const hasError = Boolean(error)
  const refs = useRef([])
  const idx = options.findIndex(o => o.value === value)

  function move(delta, e) {
    e.preventDefault()
    const enabled = options.map((o, i) => ({ o, i })).filter(x => !x.o.disabled)
    if (!enabled.length) return
    let pos = enabled.findIndex(x => x.i === idx)
    if (pos === -1) pos = 0
    else pos = (pos + delta + enabled.length) % enabled.length
    const target = enabled[pos]
    onChange?.(target.o.value)
    refs.current[target.i]?.focus()
  }
  function onKeyDown(e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(1, e)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(-1, e)
  }

  const containerStyle = layout === 'list'
    ? { display: 'flex', flexDirection: 'column', gap: 10 }
    : { display: 'grid', gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: 10 }

  return (
    <div role="radiogroup" aria-label={ariaLabel} aria-invalid={hasError || undefined}
      style={{ ...containerStyle, ...style }} onKeyDown={onKeyDown} {...rest}>
      {options.map((o, i) => {
        const selected = o.value === value
        const tabIndex = (selected || (idx === -1 && i === 0)) ? 0 : -1
        return (
          <button key={String(o.value)} type="button" role="radio" aria-checked={selected}
            disabled={o.disabled} tabIndex={o.disabled ? -1 : tabIndex}
            ref={el => { refs.current[i] = el }} onClick={() => onChange?.(o.value)}
            style={cardStyle({ selected, hasError, layout })}>
            {/* Sizes match what the emoji occupied (2rem / 1.8rem), so the card geometry is
                unchanged. Both land above the 21px master crossover, i.e. the 24 master. The tint
                tracks the label rather than carrying the selection on its own — border, fill and
                the check mark already state it three other ways. */}
            {o.iconName
              ? <Icon name={o.iconName} size={layout === 'list' ? 30 : 28} decorative
                  style={{ flexShrink: 0, color: selected ? P.green : P.dark }} />
              : o.icon != null && <span aria-hidden="true" style={{ fontSize: layout === 'list' ? '2rem' : '1.8rem', lineHeight: 1, flexShrink: 0 }}>{o.icon}</span>}
            {layout === 'list' ? (
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 700, fontSize: '1.05rem', color: selected ? P.green : P.dark, lineHeight: 1.25 }}>{o.label}</span>
                {o.description && <span style={{ display: 'block', fontSize: '0.85rem', color: P.mid, marginTop: 3, lineHeight: 1.3 }}>{o.description}</span>}
              </span>
            ) : (
              <>
                <span style={{ fontSize: '0.85rem', fontWeight: 700, color: selected ? P.green : P.dark }}>{o.label}</span>
                {o.description && <span style={{ fontSize: '0.72rem', color: P.light, lineHeight: 1.3 }}>{o.description}</span>}
              </>
            )}
            {layout === 'list' && selected && <Icon name="action.check" size={21} decorative style={{ color: P.green, flexShrink: 0 }} />}
          </button>
        )
      })}
    </div>
  )
}

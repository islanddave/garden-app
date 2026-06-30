// src/components/forms/SegmentedControl.jsx
// V4-THEME-001 (V200 Pass B) — canonical 2+-way view toggle. ONE segmented grammar for
// the Plants⇄Photos sub-tab toggle and the plant-detail Basics·Care·More tabs.
// NOT GroupByControl (that is a single-axis facet GROUP selector that can also be "none");
// this is a mutually-exclusive VIEW switch where exactly one option is always active.
// a11y: WAI-ARIA radiogroup pattern — role=radiogroup wrapper, role=radio options,
// roving tabindex + Left/Right(Up/Down) arrow selection, aria-checked on the active option.
// Ships DARK (no runtime importer until the adopting slice).
import React, { useRef } from 'react'
import { P } from '../../lib/constants.js'

export default function SegmentedControl({ options = [], value, onChange, small, ariaLabel, ...rest }) {
  const refs = useRef([])
  const idx = options.findIndex(o => o.value === value)

  function select(i) {
    const opt = options[i]
    if (!opt) return
    onChange?.(opt.value)
    refs.current[i]?.focus()
  }

  function onKeyDown(e) {
    if (!options.length) return
    const cur = idx < 0 ? 0 : idx
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault(); select((cur + 1) % options.length)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault(); select((cur - 1 + options.length) % options.length)
    } else if (e.key === 'Home') {
      e.preventDefault(); select(0)
    } else if (e.key === 'End') {
      e.preventDefault(); select(options.length - 1)
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      style={{
        display: 'inline-flex',
        padding: 3,
        gap: 3,
        borderRadius: 12,
        backgroundColor: P.cream,
        border: `1px solid ${P.border}`,
      }}
      {...rest}
    >
      {options.map((opt, i) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            ref={el => { refs.current[i] = el }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active || (idx < 0 && i === 0) ? 0 : -1}
            onClick={() => select(i)}
            style={{
              minHeight: 40,
              padding: small ? '6px 14px' : '8px 18px',
              borderRadius: 10,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: small ? '0.82rem' : '0.9rem',
              fontWeight: 600,
              border: 'none',
              backgroundColor: active ? P.white : 'transparent',
              color: active ? P.greenDeep : P.light,
              boxShadow: active ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

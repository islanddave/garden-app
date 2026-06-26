import React from 'react'
import { T, P } from '../../lib/tokens.js'

// GroupByControl — single active group-by selector for the Garden render. Segmented chip row;
// exactly one active at a time. value==='none' = the legacy by-project tree (golden path).
export default function GroupByControl({ options = [], value = 'none', onChange, style }) {
  return (
    <div role="group" aria-label="Group by" style={{ display: 'inline-flex', flexWrap: 'wrap', gap: T.space.xs, ...style }}>
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value} type="button" aria-pressed={active}
            onClick={() => onChange && onChange(opt.value)}
            style={{
              fontSize: T.type.xs, padding: `${T.space.xs}px ${T.space.sm}px`,
              borderRadius: T.radiusButton, cursor: 'pointer', fontWeight: active ? 700 : 500,
              backgroundColor: active ? P.greenPale : 'transparent',
              color: active ? P.green : P.mid,
              border: `1px solid ${active ? P.greenLight : P.border}`,
            }}
          >{opt.label}</button>
        )
      })}
    </div>
  )
}

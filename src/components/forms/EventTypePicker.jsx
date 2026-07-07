// src/components/forms/EventTypePicker.jsx
// Lane D / Phase D — single-select event-type picker, extracted verbatim from
// EventNew.jsx (no behavior change). A button-grid quick-picker: primary types in
// a 3-col + 2-col grid, the rest in a collapsible "More" panel grouped by
// EVENT_TYPE_META category. Owns the primary list (EVENT_TYPES_UI) and derives the
// secondary groups from the canonical eventTypes.js — re-exported so the prior
// importers (EventNew re-export → EventTypesPhase1.test) keep working unchanged.
//
// Composition note (plan §5 Phase D): this is the QUICK-PICKER half. The LogMany
// scope/exclusion checklist is a SEPARATE component (ScopeChecklist) — different
// render tree + state model; they share primitives, not a `mode=` switch.
import React, { useState } from 'react'
import { P } from '../../lib/constants.js'
import { buildSecondaryGroups } from '../../lib/eventTypes.js'
import Icon from '../Icon.jsx'

// Primary quick-picks (V4-EVENTSEL-002, Dave 2026-07-07: first-class set reordered to
// Watered / Transplanted / Fertilized / Flowering / Fruit Set / Harvested / Photo — and
// unified with the Log Many selector. Supersedes the V3-EVENTZONE-001 braindump set:
// mulched + suckered drop to "More"; flowering + photo promoted). slice(0,3) → 3-col grid;
// slice(3) → 2-col grid. Emojis are unique across the primary set (glyphs render via Icon).
export const EVENT_TYPES_UI = [
  { value: 'watering',    label: 'Watered',                 emoji: '💧' },
  { value: 'transplant',  label: 'Transplanted\n/ Planted', emoji: '🌱' },
  { value: 'fertilizing', label: 'Fertilized\n/ Fed',       emoji: '🌿' },
  { value: 'flowering',   label: 'Flowering',               emoji: '🌸' },
  { value: 'fruit_set',   label: 'Fruit Set',               emoji: '🍅' },
  { value: 'harvest',     label: 'Harvested',               emoji: '🧺' },
  { value: 'photo',       label: 'Photo',                   emoji: '📷' },
]

const PRIMARY_VALUES = new Set(EVENT_TYPES_UI.map(t => t.value))
export const SECONDARY_GROUPS = buildSecondaryGroups(PRIMARY_VALUES)

function TypeBtn({ type, selected, onSelect }) {
  const isSelected = selected === type.value
  return (
    <button
      type="button"
      onClick={() => onSelect(type.value)}
      style={{
        padding: '14px 6px 12px',
        border: `2px solid ${isSelected ? P.green : P.border}`,
        borderRadius: 10,
        backgroundColor: isSelected ? P.greenPale : P.white,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 7,
        transition: 'all 0.12s',
        minHeight: 80,
      }}
    >
      <Icon name={`event.${type.value}`} size={26} decorative style={{ color: isSelected ? P.green : P.mid }} />
      <span style={{
        fontSize: '0.73rem',
        fontWeight: 600,
        color: isSelected ? P.green : P.mid,
        textAlign: 'center',
        lineHeight: 1.25,
        whiteSpace: 'pre-line',
      }}>
        {type.label}
      </span>
    </button>
  )
}

export default function EventTypePicker({ value, onChange }) {
  const [showMore, setShowMore] = useState(false)
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        {EVENT_TYPES_UI.slice(0, 3).map(t => (
          <TypeBtn key={t.value} type={t} selected={value} onSelect={onChange} />
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginTop: 10 }}>
        {EVENT_TYPES_UI.slice(3).map(t => (
          <TypeBtn key={t.value} type={t} selected={value} onSelect={onChange} />
        ))}
      </div>

      <button
        type="button"
        onClick={() => setShowMore(s => !s)}
        style={{
          marginTop: 12, background: 'none', border: 'none',
          cursor: 'pointer', color: P.green, fontSize: '0.82rem',
          fontWeight: 600, padding: '4px 0',
          display: 'flex', alignItems: 'center', gap: 5,
        }}
      >
        <span>{showMore ? '▾' : '▸'}</span>
        <span>More event types</span>
      </button>

      {showMore && (
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
              <div style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${Math.min(types.length, 3)}, 1fr)`,
                gap: 8,
              }}>
                {types.map(t => (
                  <TypeBtn
                    key={t.value}
                    type={t}
                    selected={value}
                    onSelect={v => { onChange(v); setShowMore(false) }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

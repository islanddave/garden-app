// Single-select event-type picker: primary types in a 3-col + 2-col grid, the rest in a collapsible
// "More" panel grouped by EVENT_TYPE_META category. Owns the primary list (EVENT_TYPES_UI) and
// derives the secondary groups from the canonical eventTypes.js. Re-exported through EventNew for
// its prior importers (EventTypesPhase1.test).
//
// This is the QUICK-PICKER half. The LogMany scope/exclusion checklist is a SEPARATE component
// (ScopeChecklist) with a different render tree and state model; they share primitives, not a
// `mode=` switch.
import React, { useState, useMemo } from 'react'
// SELECTABLE_EVENT_TYPES, not EVENT_TYPES: the CREATION list, which drops the two plant-reduction
// types while their capture panel is unbuilt. See constants.js.
import { P, SELECTABLE_EVENT_TYPES } from '../../lib/constants.js'
import { buildSecondaryGroups } from '../../lib/eventTypes.js'
import { T } from './formStyles.js'
import Icon from '../Icon.jsx'

// Primary quick-picks, shared with the Log Many selector. slice(0,3) → 3-col grid; slice(3) → 2-col
// grid. `value` is the ONLY glyph key (TypeBtn renders <Icon name={`event.${value}`} />). Shape is
// { value, label }, the same shape buildSecondaryGroups emits, which is why TypeBtn takes both.
export const EVENT_TYPES_UI = [
  { value: 'watering',    label: 'Watered' },
  { value: 'transplant',  label: 'Transplanted\n/ Planted' },
  { value: 'fertilizing', label: 'Fertilized\n/ Fed' },
  { value: 'flowering',   label: 'Flowering' },
  { value: 'fruit_set',   label: 'Fruit Set' },
  { value: 'harvest',     label: 'Harvested' },
  { value: 'photo',       label: 'Photo' },
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

export default function EventTypePicker({ value, onChange, primaries = EVENT_TYPES_UI, available = SELECTABLE_EVENT_TYPES }) {
  const [showMore, setShowMore] = useState(false)
  // Secondary "More" groups: everything in `available` not shown as a primary tile, grouped by
  // EVENT_TYPE_META category. The defaults reproduce the module-const SECONDARY_GROUPS exactly, so
  // EventNew (passes no props) is unaffected.
  const secondaryGroups = useMemo(
    () => buildSecondaryGroups(new Set(primaries.map(t => t.value)), available),
    [primaries, available],
  )
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        {primaries.slice(0, 3).map(t => (
          <TypeBtn key={t.value} type={t} selected={value} onSelect={onChange} />
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginTop: 10 }}>
        {primaries.slice(3).map(t => (
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
          // 24px at 390x844 was under the tap floor (4px padding + a 0.82rem line box); the
          // log-chooser-clearance layout gate's tap-target census covers this control.
          minHeight: T.tapMinHeight,
          display: 'flex', alignItems: 'center', gap: 5,
        }}
      >
        <span>{showMore ? '▾' : '▸'}</span>
        <span>More event types</span>
      </button>

      {showMore && (
        <div style={{ marginTop: 8 }}>
          {secondaryGroups.map(([category, types]) => (
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

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
import React, { useState, useMemo } from 'react'
// V4-LOSSEVENT-001: SELECTABLE_EVENT_TYPES, not EVENT_TYPES — the CREATION list, which drops the
// two plant-reduction types while their capture panel is unbuilt. See constants.js for the why.
import { P, SELECTABLE_EVENT_TYPES } from '../../lib/constants.js'
import { buildSecondaryGroups } from '../../lib/eventTypes.js'
import { T } from './formStyles.js'
import Icon from '../Icon.jsx'

// Primary quick-picks (V4-EVENTSEL-002, Dave 2026-07-07: first-class set reordered to
// Watered / Transplanted / Fertilized / Flowering / Fruit Set / Harvested / Photo — and
// unified with the Log Many selector. Supersedes the V3-EVENTZONE-001 braindump set:
// mulched + suckered drop to "More"; flowering + photo promoted). slice(0,3) → 3-col grid;
// slice(3) → 2-col grid.
//
// V4-ICON-001: `emoji` removed. TypeBtn has rendered <Icon name={`event.${value}`} /> since the
// registry landed, so these were inert strings; `value` is now the ONLY glyph key. Shape is
// { value, label } — the same shape buildSecondaryGroups emits, which is why TypeBtn takes both.
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
  // EVENT_TYPE_META category. Defaults (primaries=EVENT_TYPES_UI, available=EVENT_TYPES) reproduce
  // the module-const SECONDARY_GROUPS exactly, so EventNew (passes no props) is byte-identical.
  // Log Many passes primaries=first-class-minus-photo + available=BATCH_EVENT_TYPES → one shared grid.
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
          // BUG-DISCLOSURETAPSIZE-001: 24px measured at 390x844 (4px padding + a 0.82rem line box).
          // Found by the tap-target CENSUS in scripts/layout-gate/log-chooser-clearance.mjs, not by
          // the manual audit that filed the bug — that audit named this control but attributed it
          // to EventNew's harvest disclosure, so a fix list built from the ticket alone would have
          // left it short. The census is the reason the miss surfaced.
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

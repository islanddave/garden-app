// src/components/HarvestDispositionChips.jsx
// V4-HARVDISPOSITION-001 (capture half) — the optional "what went wrong with this pick" chip row.
//
// Composed from the FROZEN SelectChip primitive (components/forms/FROZEN.md: extend, don't mint a
// second chip), and deliberately NOT added to the forms barrel — the freeze test pins that export
// set exactly, and this is a domain widget (a harvest vocabulary), not a shared primitive. Imported
// directly, the same way WaterDepthChips imports SelectChip.
//
// WHERE THIS DIVERGES FROM WaterDepthChips, and why: that row is REQUIRED with a preselected
// default, because every watering has an amount. This one is OPTIONAL and starts unselected,
// because 703 of 707 live harvests are ordinary picks and NULL is their meaning (lib/harvestDisposition.js).
// That difference drives three things here:
//   * COLLAPSED behind a disclosure by default, so the fast path costs zero taps and zero height.
//   * FORCED OPEN whenever a value is set, so an existing disposition can never hide behind a
//     collapsed summary on the edit form — the state the user most needs to see is the one a
//     default-collapsed panel would conceal.
//   * TAPPING THE ACTIVE CHIP CLEARS IT (onChange(null)), plus an explicit "Clear" text button in
//     the quality-row idiom. Both, because toggle-off is fast but undiscoverable, and a value that
//     cannot be un-set is a value the user will avoid setting.
//
// Layout: a 2-column grid, not 4. At 390px (Dave's Chrome/Android width) four `touch` chips demand
// 4*44 + 3*8 = 200px of min-content and would technically fit on one line, but "Damaged" plus its
// anchor does not — the chips would render at ~85px and truncate the anchor that makes the word
// unambiguous. Two columns give ~170px per chip and a 48px height floor, which is what a chip tapped
// one-handed while holding produce needs.
//
// Sits OUTSIDE <Field> deliberately: Field's frozen contract takes exactly one focusable control and
// clones ARIA onto it, so a chip group inside it would trip contractWarn.
import React, { useState } from 'react'
import { P } from '../lib/constants.js'
import SelectChip from './forms/SelectChip.jsx'
import { HARVEST_DISPOSITION_CHIPS } from '../lib/harvestDisposition.js'

export default function HarvestDispositionChips({
  value,
  onChange,
  idPrefix = 'harvest-disposition',
  label = 'Anything wrong with this pick?',
}) {
  const [opened, setOpened] = useState(false)
  // Derived, not an effect: a set value forces the panel open on every render, so a draft restore or
  // an edit-form seed that lands after mount cannot leave a recorded value collapsed out of sight.
  const open = opened || value != null

  return (
    <div style={{ marginTop: 16 }} data-testid={`${idPrefix}-block`}>
      <button
        type="button"
        onClick={() => setOpened(o => !o)}
        aria-expanded={open}
        data-testid={`${idPrefix}-toggle`}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', color: P.light,
          fontSize: '0.74rem', fontWeight: 700, letterSpacing: '0.3px', textTransform: 'uppercase',
          padding: '4px 0', display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span>{label}  ·  optional</span>
      </button>

      {open && (
        <>
          <div
            role="group"
            aria-label={label}
            data-testid={`${idPrefix}-group`}
            style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginTop: 8 }}
          >
            {HARVEST_DISPOSITION_CHIPS.map(chip => (
              <SelectChip
                key={chip.value}
                active={value === chip.value}
                touch
                // Toggle-off. `null` is the cleared state the server reads as "a normal pick after
                // all" (validators.js three-intent shape), NOT the absent key.
                onClick={() => onChange(value === chip.value ? null : chip.value)}
                // The accessible name carries the anchor: "Aborted" alone is the ambiguity the
                // anchors exist to remove, and a screen-reader user gets no visual caption.
                aria-label={`${chip.label} — ${chip.anchor}`}
                data-testid={`${idPrefix}-${chip.value}`}
              >
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.25 }}>
                  <span>{chip.label}</span>
                  <span
                    aria-hidden="true"
                    style={{
                      fontSize: '0.66rem', fontWeight: 500, opacity: 0.85,
                      color: value === chip.value ? P.white : P.mid,
                    }}
                  >
                    {chip.anchor}
                  </span>
                </span>
              </SelectChip>
            ))}
          </div>
          {value != null && (
            <button
              type="button"
              onClick={() => onChange(null)}
              data-testid={`${idPrefix}-clear`}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.light, fontSize: '0.78rem', padding: '8px 0 0', textDecoration: 'underline' }}
            >
              Clear — this was a normal pick
            </button>
          )}
          <p style={{ margin: '6px 0 0', color: P.light, fontSize: '0.72rem', lineHeight: 1.4 }}>
            Leave this alone for an ordinary pick. Either way the weight still counts toward your totals.
          </p>
        </>
      )}
    </div>
  )
}

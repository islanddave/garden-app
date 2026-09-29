// src/components/putup/PhReadingField.jsx
// V5-PHRECORD-001 — writing down a pH someone measured. Put-Up 1a item 3 MOVED it: it used to be an
// inline recorder on the Going-now card with its own POST; it is now the CONTROLLED pH field inside
// Check on it (CheckOnItSheet.jsx), on Ferment batches, and the sheet's Save writes the reading on
// the check-in's one row. "The pH button moves into Check on it" (V4 §2.3 / the release note). One pH
// input primitive, so Put it up's rows can host the same field in release 1b.
//
// ⚠ THE LINE THIS COMPONENT HOLDS:
//   FORBIDDEN — derive, score, colour, gate, compare to a threshold, or infer from elapsed time.
//   PERMITTED — record a measured value verbatim, prompt someone to measure, link to how.
// There is no branch below that reads a recorded value and decides anything about it. The only
// rejection anywhere on this path is the pH SCALE (goingNow.js phStagePatch), which is not a safety
// band. No verdict, no colour, no badge, no tick.
//
// AND NEVER AN AGGREGATE. Only the newest reading is shown on the card, always with its date. The
// full history is the stage log, where each reading is one dated line.
//
// `text` with inputMode decimal, never type="number": a number input hands back a coerced value and
// drops a trailing zero the meter displayed, which is the one thing this field must not do.
//
// Adjudication: project-state/_build-inflight-20260904/FOODSAFETY-RULING-V101.md §2 (gardening-docs).
// Every threshold in the evidence behind it carries a scope condition; none of them is in this file.
import React from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { inputChrome, labelChrome, optionalMarkChrome } from '../forms/formStyles.js'
import { PH_INSTRUMENT_NOTE, PH_LINK_URL, PH_LINK_LABEL, PH_SCALE_MIN, PH_SCALE_MAX } from './goingNow.js'

// The instrument note plus its link, rendered once beside the field. It is reference content for the
// person about to measure, quoted and attributed rather than paraphrased into house voice.
function InstrumentNote({ idPrefix }) {
  return (
    <div data-testid={`${idPrefix}-instrument`} style={{ marginTop: 6, color: P.light, fontSize: '0.78rem', lineHeight: 1.45 }}>
      {PH_INSTRUMENT_NOTE}{' '}
      <a href={PH_LINK_URL} target="_blank" rel="noreferrer noopener"
        data-testid={`${idPrefix}-link`} style={{ color: P.green, whiteSpace: 'nowrap' }}>
        {PH_LINK_LABEL}
      </a>
    </div>
  )
}

export default function PhReadingField({ value = '', onChange, error = null, disabled = false, idPrefix = 'checkin-ph', inputStyle }) {
  const inputId = `${idPrefix}-input`
  const errorId = `${idPrefix}-error`
  return (
    <div data-testid={`${idPrefix}-field`}>
      <label htmlFor={inputId} style={labelChrome}>
        pH reading<span style={optionalMarkChrome}>optional</span>
      </label>
      {/* min/max are the pH SCALE, restating chk_ksl_ph_scale — not a food-safety band. */}
      <input id={inputId} type="text" inputMode="decimal" value={value} disabled={disabled}
        data-testid={inputId} placeholder={`${PH_SCALE_MIN}–${PH_SCALE_MAX}`}
        aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
        onChange={e => onChange?.(e.target.value)}
        style={{ ...inputChrome(!!error), width: 120, fontSize: T.type.sm, ...inputStyle }} />
      {error && (
        <div id={errorId} role="alert" data-testid={errorId}
          style={{ marginTop: 4, color: P.terra, fontSize: '0.78rem' }}>{error}</div>
      )}
      <InstrumentNote idPrefix={idPrefix} />
    </div>
  )
}

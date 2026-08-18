// src/components/PlantReductionFields.jsx
// V4-LOSSUI-001 — the REQUIRED capture panel for the two plant-reduction event types.
//
// WHY IT IS NOT AN EVENT_METADATA_FIELDS ENTRY, which is where a per-type metadata form usually
// goes in this app: that registry drives the COLLAPSED "More details" disclosure, whose whole
// contract is that everything inside it is optional and a save works untouched. These two fields
// are required — the API 400s without either — and a required field inside an optional disclosure
// is a field the user never sees before the save it blocks. So this sits with the other REQUIRED
// type panels (harvest quantity, treatment details, flag severity) as a plain visible Section.
//
// Composed from the FROZEN SelectChip primitive (components/forms/FROZEN.md: extend, don't mint a
// second chip) and, like WaterDepthChips, deliberately NOT added to the forms barrel — the freeze
// test pins that export set exactly and this is a domain widget, not a shared primitive.
//
// The chip row is driven off LOSS_REASONS / GIVEAWAY_REASONS through reductionReasonsFor(), never
// a local copy: those two lists are also the API validator's vocabulary (via the generated Lambda
// mirror) and the whole point of the storage-layer separation is that one list answers both.
import React from 'react'
import { P } from '../lib/constants.js'
import SelectChip from './forms/SelectChip.jsx'
import Field from './forms/Field.jsx'
import Input from './forms/Input.jsx'
import Section from './FormSection.jsx'
import { REDUCTION_REASON_HINTS, reductionReasonLabel } from '../lib/eventTypes.js'
import { reductionReasonsFor } from '../lib/plantReduction.js'

// Per-type copy. Keyed by event type rather than branched on, so adding a third reduction type is a
// data change; and worded as the question the user is actually answering — "How many did you lose?"
// rather than "Quantity", which on a form that also has a harvest quantity is ambiguous.
const COPY = {
  failed: {
    section: 'Plants lost *',
    qtyLabel: 'How many did you lose? *',
    qtyPlaceholder: 'e.g. 3',
    reasonLabel: 'What happened?',
    reasonGroup: 'What happened to them',
  },
  given_away: {
    section: 'Plants given away *',
    qtyLabel: 'How many did you give away? *',
    qtyPlaceholder: 'e.g. 2',
    reasonLabel: 'Where did they go?',
    reasonGroup: 'Where they went',
  },
}

export default function PlantReductionFields({
  eventType,
  qty,
  reason,
  onQty,
  onReason,
  error = null,
  // The planting's current count, when the caller knows it. INFORMATION ONLY — see
  // lib/plantReduction.js for why this never gates the save.
  remaining = null,
}) {
  const copy = COPY[eventType]
  const reasons = reductionReasonsFor(eventType)
  if (!copy || reasons.length === 0) return null

  const inputId = `reduction-qty-${eventType}`
  const hint = REDUCTION_REASON_HINTS[reason]

  return (
    // The SAME FormSection card every other required panel on this form uses (Harvest *, What
    // happened? *, Planting *) — this is a peer of those, not a new kind of block, and it should
    // not announce itself as one.
    <Section label={copy.section}>
      <div data-testid={`reduction-panel-${eventType}`}>
        <Field label={copy.qtyLabel} htmlFor={inputId}>
          {/* type=text + inputMode=numeric, matching the harvest quantity field and for the same
              measured reason: on Chrome Android an invalid intermediate value in a type=number
              input makes .value return '', turning a typo into a silently empty required field. */}
          <Input
            id={inputId}
            type="text"
            inputMode="numeric"
            value={qty}
            onChange={e => onQty(e.target.value)}
            aria-label={copy.qtyLabel.replace(' *', '')}
            error={!!error}
            placeholder={copy.qtyPlaceholder}
            data-testid="reduction-qty"
          />
        </Field>

        {remaining != null && (
          <div style={{ marginTop: 6, color: P.mid, fontSize: '0.76rem' }} data-testid="reduction-remaining">
            {remaining === 1 ? '1 left on this planting right now.' : `${remaining} left on this planting right now.`}
          </div>
        )}

        <div style={{ marginTop: 14, fontSize: '0.74rem', fontWeight: 700, color: P.light, marginBottom: 8, letterSpacing: '0.3px', textTransform: 'uppercase' }}>
          {copy.reasonLabel}
        </div>
        {/* Outside <Field> deliberately: Field's frozen contract takes EXACTLY ONE focusable control
            and clones ARIA onto it, so a chip group inside it would trip contractWarn and steal the
            input's wiring. Same placement decision as the harvest quick-pick chips. */}
        <div
          role="group"
          aria-label={copy.reasonGroup}
          data-testid={`reduction-reasons-${eventType}`}
          // Three columns, not one row and not flex-wrap. The content width available to this grid
          // at 390px (Dave's Chrome/Android width) is 390 − 32 (EventNew's page padding) − 36
          // (FormSection's) = 322px. Seven `touch` chips on ONE line demand 7*44 + 6*8 = 356px of
          // min-content, which is 34px MORE than there is — the harvest row's
          // BUG-HARVROWOVERFLOW-001 failure exactly, where a grid asking for more than the viewport
          // scrolled the overlay sideways. Three columns gives 102px per chip, comfortably above the
          // ~96px min-content of the longest unbreakable word here ("Transplant"), so long labels
          // wrap to two lines inside their chip instead of forcing the row wider than the screen.
          // ARITHMETIC, not a measurement: jsdom has no layout engine and no browser tooling was
          // available in this lane (see the lane report) — worth a real 390px eyeball on device.
          style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}
        >
          {reasons.map(r => (
            <SelectChip
              key={r}
              active={reason === r}
              touch
              small
              onClick={() => onReason(r)}
              data-testid={`reduction-reason-${r}`}
            >
              {reductionReasonLabel(r)}
            </SelectChip>
          ))}
        </div>

        {hint && (
          // The catch-all's expansion, revealed on selection rather than standing permanently: it is
          // reassurance that the choice was right, and it only means anything once one is picked.
          <div style={{ marginTop: 8, color: P.mid, fontSize: '0.74rem' }} data-testid="reduction-reason-hint">
            {hint}
          </div>
        )}

        {error && (
          <div role="alert" style={{ marginTop: 10, fontSize: '0.78rem', color: P.terra, fontWeight: 600 }}>{error}</div>
        )}
      </div>
    </Section>
  )
}

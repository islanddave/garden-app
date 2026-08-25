// WeighWizard.jsx — V4-WEIGHWIZARDFLOW-001 (BD-055) / V4-WEIGHMOBILEVIEWPORT-001 (BD-045), Slice 1.
// Design: project-state/_hp-20260825/design-weighwizard-V100-20260825.md.
//
// WHAT SLICE 1 IS. The spine plus STEP 1 (which planting). Entering /log?session=harvest with
// WEIGH_WIZARD_ENABLED on raises this sheet immediately — no landing screen, which is the first
// beat Dave described. Picking a planting sets plant_id and CLOSES the wizard, handing off to the
// form that already prompts for count and weight. Slices 2-3 take those steps over; until they do,
// this strands nobody.
//
// WHY THE LIST IS THE STEP BODY, and not PlantingSelect's popover moved into a sheet. Measured this
// session in tests/harness at a true 390x500 (iframe host — a narrow --window-size CROPS instead of
// reflowing): with the chooser open, elementFromPoint at the centre of the quantity pad's backspace
// returns `ps-opt-plant-2`, a chooser ROW, at 390x500 AND at 390x844. checkVisibility() says true;
// the key is painted and unreachable. Embedding the popover here would carry that with it, along
// with computePlacement's above/below flip — the second half of BD-045. A step body has no anchor,
// so there is no placement decision to be inconsistent about.
//
// It is NOT a fork of PlantingSelect: the label formatter (plantingQtyVarietyLabel) and the fixed
// 44px row height come straight from it, so long names ellipsize and row y-positions stay
// deterministic under a keyboard for the same reason they do there. What this deliberately does not
// yet carry is the crop-chip band, the mic and the recent-pick ranking — Slice 2, called out rather
// than dropped quietly.
//
// NO PHYSICAL left:/right: OFFSETS ANYWHERE IN THIS FILE. Dave operates the weigh-in left-handed
// and whether that becomes a preference is unsettled (design §6 maps all eight dependent sites).
// Flex order and gridColumn are reversible in one place later; absolute offsets are not — that is
// the trap comboboxInput.js:145-177 is already stuck in.
import React, { useEffect, useMemo, useState } from 'react'
import { P } from '../lib/constants.js'
import Sheet from './forms/Sheet.jsx'
import Input from './forms/Input.jsx'
import { plantingQtyVarietyLabel } from './forms/PlantingSelect.jsx'
import { STEP_PLANTING, stepTitle } from '../lib/weighWizard.js'

// Same 44px floor PlantingSelect pins, and for its reason: a long name with no ellipsis wraps, grows
// the row, and shifts the y-position of every row under it, so "the third result" lands somewhere
// different depending on how long the second one was.
const ROW_H = 44

function matches(label, query) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return label.toLowerCase().includes(q)
}

export default function WeighWizard({
  open,
  step = STEP_PLANTING,
  plants = [],
  plantingName = null,
  // onPick(id) — Slice 1's whole hand-off: set plant_id, then close.
  onPick,
  onDismiss,
  dirty = false,
  // Open question 2 for Dave (design §9): should the chooser raise the keyboard on open? Both
  // answers lay out cleanly, so this is a prop with a named default rather than a second flag or a
  // hardcode. Default false: in a full-height sheet the list already shows ~8 rows, and a keyboard
  // cuts that to ~4 — the keyboard's own benefit is competing with what it used to compete with.
  keyboardOnOpen = false,
}) {
  const [query, setQuery] = useState('')

  // Reset the filter each time the sheet opens: a query left over from the previous entry is a
  // silently-narrowed list, which reads as "that planting is gone".
  useEffect(() => { if (open) setQuery('') }, [open])

  useEffect(() => {
    if (!open || !keyboardOnOpen) return
    // Found by id, not a ref: Input is a FROZEN primitive and a plain function component, so it
    // forwards no ref — the same reason ConfirmSheet.jsx:78 queries for its cancel button, and the
    // idiom EventNew already uses (document.getElementById('harvest-quantity')?.focus()).
    // Chrome Android only opens the keyboard for a focus carrying user activation
    // (PlantingSelect.jsx:441-444), so this is best-effort by construction: with no activation it
    // focuses without raising an IME, which is the safe miss.
    document.getElementById('weigh-wizard-search')?.focus()
  }, [open, keyboardOnOpen])

  const rows = useMemo(() => (
    (plants || [])
      .map(p => ({ id: p.id, label: plantingQtyVarietyLabel(p) }))
      .filter(r => matches(r.label, query))
  ), [plants, query])

  const title = stepTitle(step, plantingName)

  return (
    <Sheet
      open={!!open}
      onClose={onDismiss}
      title={title}
      size="full"
      // The three props c0507f3 landed and nothing had used together. `dirty` is the IN-FLIGHT entry
      // only; rows already saved this session are server-side and are never at risk, which is what
      // the body copy says. A confirm that overstates the loss trains the user to dismiss it.
      dirty={dirty}
      confirmOnDirty
      confirmTitle="Discard this harvest?"
      confirmBody="The count and weight you entered will be lost. Picks you already saved are kept."
      // Dave is Android-only, so Back is the gesture that fires this. armsBack routes it to the
      // registry, which re-arms after a cancelled Back so a second press asks again instead of
      // exiting the app.
      armsBack
      closeLabel="Leave weigh-in"
    >
      <div data-testid="weigh-wizard" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Input
          id="weigh-wizard-search"
          data-testid="weigh-wizard-search"
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Search plantings"
          placeholder="Search plantings…"
        />
        {/* The list SHRINKS rather than overflows when the keyboard is up. index.html:16 ships
            interactive-widget=resizes-content, so the soft keyboard shrinks the layout viewport and
            a bottom-fixed panel sits above it for free; 100dvh then re-resolves to the shrunk
            viewport and this max-height follows it down. NO visualViewport arithmetic — that is the
            regression noViewportInsetArithmetic.static.test.js exists to catch, and the platform
            question is already solved by the meta tag. */}
        <div
          role="listbox"
          aria-label="Plantings"
          data-testid="weigh-wizard-list"
          style={{
            marginTop: 10,
            maxHeight: 'calc(100dvh - 190px - env(safe-area-inset-bottom))',
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {rows.length === 0 && (
            <div data-testid="weigh-wizard-empty" style={{ padding: 10, fontSize: '0.8rem', color: P.light }}>
              {plants.length === 0 ? 'No plantings yet.' : 'No plantings match that.'}
            </div>
          )}
          {rows.map(r => (
            <button
              key={r.id}
              type="button"
              role="option"
              aria-selected="false"
              data-testid={`weigh-wizard-opt-${r.id}`}
              // Picking ADVANCES immediately — no confirm tap. That is the point of the step, and
              // it is safe here in a way a focus jump is not: the advance is visible, and every
              // later step names the planting in its header.
              onClick={() => onPick?.(r.id)}
              style={{
                display: 'block',
                width: '100%',
                // No textAlign flip and no absolute offset: see the handedness note in the header.
                textAlign: 'start',
                height: ROW_H,
                minHeight: ROW_H,
                boxSizing: 'border-box',
                padding: '11px 10px',
                border: 'none',
                borderRadius: 5,
                backgroundColor: 'transparent',
                color: P.dark,
                fontFamily: 'inherit',
                fontSize: '0.88rem',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  )
}

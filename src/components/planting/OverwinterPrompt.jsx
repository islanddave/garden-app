// V4-OVERWINTERCARE-001 — the affordance that turns overwintering ON for a planting.
//
// v4.34.0 shipped the whole evaluation path and nothing that could write to it: the attribute was
// reachable only by hand-writing a jsonb row into care_profile, so in practice the feature did not
// exist. This is the tap.
//
// WHY IT LIVES ON THE PLANTING PAGE, next to the care band rather than inside the Garden editor.
// The decision is made in front of the plant — "I just put the row cover on this bed" — and the
// planting page is where that thought lands. The Garden editor is three taps away behind /garden
// ?edit=<id>, writes plants columns through a COALESCE-merge PUT, and has no idiom for a key in
// another table; V4-ARCHIVEINPLACE-001 already moved a control OUT of it for exactly the
// reach reason. Ordered directly under CareStatus because it CHANGES what CareStatus will say.
//
// DELIBERATELY LOW SALIENCE, and always present. Same chrome-less tappable-row shape as
// TransplantDatePrompt (0.82rem, tinted verb phrase, >=44px touch target, no card, no banner, no
// colour block) — this is a setting, not a nudge, and the reward-UX rules put a permanent control
// at the bottom of the salience ladder. It does NOT hide itself outside winter: gating a garden
// affordance on the calendar is exactly what the no-date-based-gating rule forbids, and the
// overwinter decision is made when the cover goes on, not when a date passes.
import React, { useState } from 'react'
import { P } from '../../lib/constants.js'
import { useApiFetch } from '../../lib/api.js'
import { useOptionalToast } from '../../context/ToastContext.jsx'
import Sheet from '../forms/Sheet.jsx'
import Button from '../forms/Button.jsx'
import ChoiceGrid from '../forms/ChoiceGrid.jsx'
import { OVERWINTER_REGIME_OPTIONS, overwinterRegimeOf, overwinterLabel } from '../../lib/overwinterRegimes.js'

export default function OverwinterPrompt({ planting, onUpdated }) {
  const { fetch } = useApiFetch()
  const toast = useOptionalToast()
  const [open, setOpen] = useState(false)
  const [regime, setRegime] = useState(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  if (!planting?.id) return null

  const current = planting.overwintering ?? null
  const currentRegime = overwinterRegimeOf(current)
  const currentLabel = overwinterLabel(current)

  function openSheet() {
    setRegime(currentRegime)
    setErr(null)
    setOpen(true)
  }

  // One writer for both directions. `clear` sends {regime:null}, which the Lambda reads as CLEAR and
  // answers with overwintering:null — so the local patch below is always the server's own answer
  // rather than a client guess about what the write did.
  async function submit(clear) {
    if (saving) return
    if (!clear && !regime) { setErr('Pick how this planting is being overwintered.'); return }
    setSaving(true)
    setErr(null)
    try {
      const res = await fetch(`/api/plants/${planting.id}/overwinter`, {
        method: 'PATCH',
        body: JSON.stringify(clear ? { regime: null } : { regime }),
      })
      setOpen(false)
      toast.show({
        message: clear ? 'Overwintering cleared' : 'Overwintering set',
        tone: 'success',
      })
      // Patch the loaded record in place so the row below re-labels immediately, mirroring
      // CropCard's onUpdated contract. The nightly plan is what actually changes cadence, so there
      // is nothing else on this page to refresh.
      if (onUpdated) onUpdated({ overwintering: res?.overwintering ?? null })
    } catch {
      setErr("Couldn't save that. Try again.")
      toast.show({ message: "Couldn't save the overwintering setting", tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openSheet}
        data-testid="overwinter-prompt"
        aria-label={currentLabel
          ? `Overwintering: ${currentLabel}. Change or clear.`
          : 'Set up winter care for this planting'}
        style={{
          display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 5,
          minHeight: 44, padding: 0, margin: 0, border: 'none', background: 'none',
          font: 'inherit', fontSize: '0.82rem', color: P.mid, textAlign: 'left', cursor: 'pointer',
        }}
      >
        <span>🧣 Overwintering —</span>
        <span style={{ color: P.green, fontWeight: 600, borderBottom: `1px dashed ${P.greenLight}` }}>
          {currentLabel ?? 'set up winter care'}
        </span>
      </button>

      <Sheet
        armsBack
        open={open}
        onClose={() => setOpen(false)}
        title="Overwintering"
        busy={saving}
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <p style={{ margin: 0, fontSize: '0.85rem', color: P.mid, lineHeight: 1.5 }}>
            Winter care is a <strong>reduced check</strong>, never a skip — a dry freeze kills more
            plants than the cold does. Pick how this one is being carried through; it goes back to
            normal on its own when the days lengthen again.
          </p>
          <ChoiceGrid
            layout="list"
            ariaLabel="How this planting is being overwintered"
            value={regime}
            onChange={setRegime}
            options={OVERWINTER_REGIME_OPTIONS}
            error={err && !regime ? err : null}
          />
          {err && <div role="alert" style={{ fontSize: '0.82rem', color: P.terra }}>{err}</div>}
          <Button onClick={() => submit(false)} loading={saving} loadingLabel="Saving…">Save</Button>
          {/* The undo half, shown only when there is something to undo. A jsonb key is deletable and
              this is the control that deletes it — the reversibility the attribute was chosen over a
              status value FOR is only real if it is reachable from the same place that set it. */}
          {currentRegime && (
            <Button variant="secondary" onClick={() => submit(true)} disabled={saving}>
              Not overwintering
            </Button>
          )}
        </div>
      </Sheet>
    </>
  )
}

// V4-MATURITYBASIS-001 — "add transplant date" affordance.
//
// Slice A suppresses the Est.-harvest window for a from-transplant crop that has no
// transplanted_at / planted_out_at (computeMaturity -> awaitingTransplant, design D3): 50 windows
// in prod went blank rather than showing a date anchored on the wrong end of the nursery period.
// A blank slot with no way out is a dead end, so this puts a tappable way to fix it EXACTLY where
// the date would have been.
//
// Deliberately NOT headline treatment (Dave's call): no banner, no card, no auto-opening modal, no
// colour block. Same type scale (0.82rem) and same ink as the label it replaces; only the verb
// phrase is tinted + underlined to read as tappable. The touch target is >=44px tall via minHeight
// on an otherwise chrome-less button, so the affordance is thumb-sized on Android/Chrome without
// gaining any visual weight.
//
// Saving PATCHes /api/plants/:id {transplanted_at} (the existing set-only lifecycle write path,
// lambda/plants/index.js:352) and hands the date back through onSaved so the parent can patch its
// record in place — the corrected window renders immediately, without a refetch round trip.
import React, { useState } from 'react'
import { P } from '../../lib/constants.js'
import { useApiFetch } from '../../lib/api.js'
import { useOptionalToast } from '../../context/ToastContext.jsx'
import Sheet from '../forms/Sheet.jsx'
import Field from '../forms/Field.jsx'
import Input from '../forms/Input.jsx'
import Button from '../forms/Button.jsx'

// Local-calendar today as YYYY-MM-DD. toISOString() would be UTC and can land on the wrong day
// west of Greenwich, which is exactly where this app is used.
function todayISO() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// Lifecycle dates arrive as either a bare 'YYYY-MM-DD' or a full timestamp; <input type="date">
// only accepts the former.
function dateOnly(value) {
  return value ? String(value).slice(0, 10) : null
}

export default function TransplantDatePrompt({ planting, onSaved }) {
  const { fetch } = useApiFetch()
  const toast = useOptionalToast()
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  if (!planting?.id) return null

  const sown = dateOnly(planting.sown_at)

  function openSheet() {
    setDate(dateOnly(planting.transplanted_at) || todayISO())
    setErr(null)
    setOpen(true)
  }

  async function save() {
    if (saving) return
    if (!date) { setErr('Pick a date first.'); return }
    // The sow date is a hard floor. A transplant date before it is not just implausible — it would
    // produce a maturity window EARLIER than the sow-anchored one this whole change exists to push
    // later, i.e. the original bug, re-entered by hand.
    if (sown && date < sown) {
      setErr(`Transplanting can't be before the sow date (${sown}).`)
      return
    }
    setSaving(true)
    setErr(null)
    try {
      await fetch(`/api/plants/${planting.id}`, {
        method: 'PATCH',
        // approx=false: this is a date the user just typed, not a CAL-8 estimate.
        body: JSON.stringify({ transplanted_at: date, transplanted_at_approx: false }),
      })
      toast.show({ message: 'Transplant date saved', tone: 'success' })
      setOpen(false)
      if (onSaved) onSaved({ transplanted_at: date, transplanted_at_approx: false })
    } catch {
      setErr("Couldn't save that date. Try again.")
      toast.show({ message: "Couldn't save the transplant date", tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openSheet}
        data-testid="add-transplant-date"
        aria-label="Add a transplant date to get an estimated harvest window"
        style={{
          display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 5,
          minHeight: 44, padding: 0, margin: 0, border: 'none', background: 'none',
          font: 'inherit', fontSize: '0.82rem', color: P.mid, textAlign: 'left', cursor: 'pointer',
        }}
      >
        <span>⏳ Est. harvest —</span>
        <span style={{ color: P.green, fontWeight: 600, borderBottom: `1px dashed ${P.greenLight}` }}>
          add transplant date
        </span>
      </button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Transplant date"
        dirty={saving}
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <p style={{ margin: 0, fontSize: '0.85rem', color: P.mid, lineHeight: 1.5 }}>
            This crop&rsquo;s days-to-maturity is counted from the day it goes in the ground, so the
            harvest window needs a transplant date.
          </p>
          <Field label="Transplanted on" htmlFor="transplant-date-input">
            <Input
              id="transplant-date-input"
              type="date"
              value={date}
              min={sown || undefined}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          {err && (
            <div role="alert" style={{ fontSize: '0.82rem', color: P.terra }}>{err}</div>
          )}
          <Button onClick={save} loading={saving} loadingLabel="Saving…">Save</Button>
        </div>
      </Sheet>
    </>
  )
}

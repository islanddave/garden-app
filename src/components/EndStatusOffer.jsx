// src/components/EndStatusOffer.jsx
// V4-LOSSUI-001 — the client half of Dave's ruling: "OFFER it. Never automatic."
//
// The events Lambda returns `plant_reduction` on the 201 when — and ONLY when — the reduction just
// taken emptied the planting. It carries a `composition` ({harvested, lost, given_away}) and a
// RANKED `offer_end_status`, most-plausible first, with ties never promoting 'failed' (a wrong
// "failed" mislabels a successful harvested-out season; a wrong "harvested" is one tap to correct).
// On a PARTIAL reduction the field is null and NOTHING is shown — a partial reduction is the common
// case and must stay a silent one-tap log. That branch is the caller's (`offer && <EndStatusOffer>`)
// and it is asserted from both sides.
//
// NOTHING HERE IS AUTOMATIC. The server has already committed the ledger row; the planting IS empty
// and the reason IS recorded whatever happens next. Applying a status is a separate, ordinary
// plants PUT, made only on an explicit tap. Declining — Close, backdrop, Escape, or the Android
// Back gesture — leaves the status exactly as it was, which is the right default for a user who is
// not sure yet.
//
// DISMISSAL GOES THROUGH <Sheet>, WHICH GOES THROUGH DismissRegistry. Not hand-rolled: the registry
// (context/DismissRegistry.jsx) is the app's single arbiter of Escape, Android Back and aria-modal
// ownership across 17 consumers, and a bespoke outside-click handler here would skip Back entirely,
// mis-order against the OverlayHost sheet EventNew renders inside, and ignore the busy/dirty
// coordination. `armsBack` is TRUE deliberately — this surface closes in place (it does not
// navigate), which is exactly the membership test in Sheet's header, and Back must dismiss it
// WITHOUT applying a status.
import React, { useState } from 'react'
import { P, statusLabel } from '../lib/constants.js'
import Sheet from './forms/Sheet.jsx'
import Button from './forms/Button.jsx'

// The composition line, in the order the ledger accumulates it. Zero-valued arms are dropped: "gave
// away 0" is noise on a planting that was never given away, and the sentence has to be readable in
// one glance on a 390px screen.
export function compositionPhrase(composition = {}) {
  const parts = []
  if (composition.harvested > 0) parts.push(`harvested ${composition.harvested}`)
  if (composition.lost > 0) parts.push(`lost ${composition.lost}`)
  if (composition.given_away > 0) parts.push(`gave away ${composition.given_away}`)
  return parts.join(' · ')
}

export default function EndStatusOffer({ offer, plantName, onApply, onDismiss }) {
  const [applying, setApplying] = useState(null)
  const [error, setError] = useState(null)
  if (!offer) return null

  const statuses = Array.isArray(offer.offer_end_status) ? offer.offer_end_status : []
  if (statuses.length === 0) return null
  const phrase = compositionPhrase(offer.composition)

  async function apply(status) {
    setError(null)
    setApplying(status)
    try {
      await onApply(status)
    } catch {
      // The EVENT is saved either way — this failure costs a status, not the record — so it is
      // surfaced in place with the sheet left open to retry rather than closing over the top of it.
      setError('That didn’t go through — try again, or set the status on the planting itself.')
      setApplying(null)
    }
  }

  return (
    <Sheet
      open
      onClose={onDismiss}
      title={plantName ? `Nothing left on ${plantName}` : 'Nothing left on this planting'}
      closeLabel="Leave the status as it is"
      // `busy` while a PUT is in flight: the registry swallows Escape/Back and Sheet no-ops the
      // backdrop tap, so a stray gesture cannot discard the sheet mid-write.
      busy={!!applying}
      armsBack
    >
      <div style={{ padding: '4px 18px 8px' }}>
        {phrase && (
          <p style={{ margin: '0 0 10px', color: P.mid, fontSize: '0.85rem' }} data-testid="end-status-composition">
            You’ve recorded {phrase}.
          </p>
        )}
        <p style={{ margin: '0 0 14px', color: P.dark, fontSize: '0.92rem', fontWeight: 600 }}>
          How did this planting end?
        </p>

        <div style={{ display: 'grid', gap: 10 }}>
          {statuses.map((s, i) => (
            <Button
              key={s}
              // The ranking is the server's and it is real information — the first option is the
              // one the composition actually supports. Rendering all three identically would throw
              // that away and make the common case cost the same read as the rare one.
              variant={i === 0 ? 'primary' : 'secondary'}
              disabled={!!applying && applying !== s}
              loading={applying === s}
              loadingLabel="Saving…"
              onClick={() => apply(s)}
              data-testid={`end-status-${s}`}
            >
              {statusLabel(s)}
            </Button>
          ))}
        </div>

        <button
          type="button"
          onClick={onDismiss}
          disabled={!!applying}
          data-testid="end-status-decline"
          // A VISIBLE decline, not just the ✕. Dave must be able to say "not yet" without hunting
          // for a close affordance, and the wording states the consequence rather than naming a
          // gesture: nothing changes, and the reduction he just logged is already saved.
          style={{
            marginTop: 14, width: '100%', minHeight: 44, background: 'none', border: 'none',
            color: P.mid, fontSize: '0.84rem', fontWeight: 600, cursor: applying ? 'default' : 'pointer',
          }}
        >
          Leave it as it is
        </button>

        {error && (
          <div role="alert" style={{ marginTop: 10, fontSize: '0.8rem', color: P.terra, fontWeight: 600 }}>{error}</div>
        )}
      </div>
    </Sheet>
  )
}

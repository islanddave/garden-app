// SettingsControls — V4-HANDEDNESSCONTROLS-001 (BD-054). Which hand works the phone.
//
// WHY A SETTING AND NOT A CONSTANT. Dave, verbatim: "I want a setting if at all possible. My usage
// may easily change based on setup/kitchen space." A hardcoded left-handed layout would also be
// wrong for the app's other user — and getting it wrong for her is not cosmetic, because it puts a
// 10-20 day snooze under her thumb (src/lib/handedness.js).
//
// WHY ITS OWN PAGE RATHER THAN A SECTION OF /settings/notifications. That page is titled
// "Notifications" and is about critter visits; handedness is neither. Settings.jsx's own header has
// anticipated this since MVP-Critter Session 4 — "when a second settings page lands later, refactor
// to a real /settings parent". This is that second page, added WITHOUT doing the parent refactor:
// /settings still redirects to notifications and its two tests are untouched. Turning /settings into
// a real index is a nav-structure change nobody asked for in this lane, and it would put a hop in
// front of the one destination that exists today.
//
// NO CONFIRM, NO SAVE BUTTON, NO TOAST. The choice applies on tap and is instantly reversible by
// the control that made it, so a confirmation step would be pure friction — and the Reward-UX
// posture forbids celebrating an operational control anyway.
import React from 'react'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { HANDS, writeHand, orderByThumb } from '../lib/handedness.js'
import { useHandedness, useHandednessSync } from '../hooks/useHandedness.js'
import { saveHandedness } from '../lib/notificationPrefsClient.js'

const LABELS = {
  right: 'Right-handed',
  left: 'Left-handed',
}
const HINTS = {
  right: 'Main controls sit on the right, where a right thumb lands. This is the default.',
  left: 'Main controls move to the left — for working the phone one-handed while your right hand is busy.',
}

export default function SettingsControls() {
  const { getToken } = useApiFetch()
  const hand = useHandedness()
  useHandednessSync(getToken)

  const choose = (v) => {
    // LOCAL FIRST, ALWAYS. writeHand dispatches the change event, so every wired surface — including
    // the preview below — turns over in the same frame whether or not the network is reachable.
    // The server write is fire-and-forget on top of it and NEVER throws (notificationPrefsClient).
    writeHand(v)
    saveHandedness({ getToken, value: v })
  }

  return (
    <div data-testid="settings-controls-page" style={{ maxWidth: 600, margin: '0 auto', padding: '24px 20px 80px' }}>
      <h1 style={{ fontSize: '1.4rem', margin: '0 0 4px', color: P.dark }}>Controls</h1>
      <p style={{ fontSize: '0.92rem', color: P.light, margin: '0 0 24px' }}>
        Which hand you work the app with.
      </p>

      <div
        role="radiogroup"
        aria-label="Handedness"
        data-testid="handedness-radiogroup"
        style={{ background: P.white, border: `1px solid ${P.border}`, borderRadius: 10 }}
      >
        {HANDS.map((opt, idx) => {
          const selected = hand === opt
          return (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={selected}
              data-testid={`handedness-option-${opt}`}
              onClick={() => choose(opt)}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 12, width: '100%', textAlign: 'left',
                minHeight: 48, padding: '12px 14px', background: 'none', cursor: 'pointer',
                fontFamily: 'inherit', color: P.dark, border: 'none',
                borderTop: idx === 0 ? 'none' : `1px solid ${P.border}`,
              }}
            >
              <span aria-hidden="true" style={{
                width: 20, height: 20, borderRadius: '50%', flexShrink: 0, marginTop: 2,
                border: `2px solid ${selected ? P.green : P.border}`,
                background: selected ? P.green : P.white,
              }} />
              <span style={{ flex: 1 }}>
                <span style={{ display: 'block', fontSize: '0.96rem', fontWeight: 600 }}>{LABELS[opt]}</span>
                <span style={{ display: 'block', fontSize: '0.82rem', color: P.light, marginTop: 2, lineHeight: 1.4 }}>
                  {HINTS[opt]}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {/* THE PREVIEW IS THE POINT OF THIS PAGE, not decoration. The setting's whole consequence is
          WHICH CONTROL ENDS UP UNDER YOUR THUMB, and that is unreadable from two radio labels. This
          is a real orderByThumb row — the same primitive HarvestWatchBand uses — so it cannot drift
          from the surfaces it is describing, and it flips as you tap. */}
      <div style={{ marginTop: 24 }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: P.light }}>
          What changes
        </div>
        <div style={{ fontSize: '0.82rem', color: P.mid, margin: '4px 0 10px', lineHeight: 1.45 }}>
          On a two-control row, the one you tap most sits under your thumb and the one that
          undoes work sits out of its way.
        </div>
        <div
          data-testid="handedness-preview"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24,
            background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '10px 14px',
          }}
        >
          {orderByThumb(
            hand,
            <span key="safe" style={{ fontSize: '0.78rem', fontWeight: 600, color: P.green }}>Log harvest</span>,
            <span key="risky" style={{ fontSize: '0.78rem', fontWeight: 600, color: P.mid }}>Not yet</span>,
          )}
        </div>
      </div>

      {/* Honest about the scope of what just changed. The preference is stored on this device
          immediately; the cross-device half needs a column that is authored and not yet applied
          (migrations/v4-handednesscontrols-001), so promising "on all your devices" here would be a
          claim the app cannot currently keep. */}
      <p style={{ fontSize: '0.78rem', color: P.light, marginTop: 16, lineHeight: 1.5 }}>
        Saved on this device. The weigh-in button on the Harvests header stays on the right either
        way — you tap it before you pick anything up, so both hands are free.
      </p>
    </div>
  )
}

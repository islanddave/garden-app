// SettingsControls: which hand works the phone.
//
// A setting and not a constant: usage changes with setup and kitchen space, and a hardcoded
// left-handed layout would be wrong for the app's other user, putting a 10-20 day snooze under her
// thumb (src/lib/handedness.js).
//
// Its own page rather than a section of /settings/notifications, which is about critter visits.
// /settings still redirects to notifications; turning it into a real index is a nav-structure change
// that would add a hop in front of the one destination that exists.
//
// No confirm, no save button, no toast: the choice applies on tap and is instantly reversible by the
// control that made it, and the Reward-UX posture forbids celebrating an operational control.
import React from 'react'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { HANDS, writeHand, orderByThumb } from '../lib/handedness.js'
import { useHandedness, useHandednessSync } from '../hooks/useHandedness.js'
import { saveHandedness } from '../lib/notificationPrefsClient.js'
import { useShowOthers, writeShowOthers } from '../lib/householdView.js'

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
    // Local first: writeHand dispatches the change event, so every wired surface (including the
    // preview below) turns over in the same frame whether or not the network is reachable. The server
    // write is fire-and-forget on top of it and never throws (notificationPrefsClient).
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

      {/* The preview is the point of this page: the setting's whole consequence is which control ends up
          under your thumb, and that is unreadable from two radio labels. It is a real orderByThumb row,
          the same primitive HarvestWatchBand uses, so it cannot drift from the surfaces it describes. */}
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

      {/* The copy claims only what is true: the preference is stored on this device immediately, and
          the cross-device half is a best-effort server write, so "on all your devices" would overpromise. */}
      <p style={{ fontSize: '0.78rem', color: P.light, marginTop: 16, lineHeight: 1.5 }}>
        Saved on this device. The weigh-in button on the Harvests header stays on the right either
        way — you tap it before you pick anything up, so both hands are free.
      </p>

      <HouseholdRow />
    </div>
  )
}

// The household view's switch. The redesigned Today has no pill of its own, so this is the way to turn it on.
// It is the same per-device key the old page's pill writes (lib/householdView.js), so the two pages agree;
// Today reads it live. Per phone on purpose: turning it on here never puts someone else's care on another
// phone. No confirm and no toast, like the handedness choice above: it applies on tap and the same tap undoes it.
function HouseholdRow() {
  const on = useShowOthers()
  return (
    <div style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: '1.1rem', margin: '0 0 4px', color: P.dark }}>Today</h2>
      <div style={{ background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, marginTop: 10 }}>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          data-testid="household-view-switch"
          onClick={() => writeShowOthers(!on)}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 12, width: '100%', textAlign: 'left',
            minHeight: 48, padding: '12px 14px', background: 'none', cursor: 'pointer',
            fontFamily: 'inherit', color: P.dark, border: 'none',
          }}
        >
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', fontSize: '0.96rem', fontWeight: 600 }}>Show the rest of the household’s care</span>
            <span style={{ display: 'block', fontSize: '0.82rem', color: P.light, marginTop: 2, lineHeight: 1.4 }}>
              Adds each other person’s care to Today as its own section, and their plants to Protect tonight. On this phone only.
            </span>
          </span>
          <span aria-hidden="true" style={{
            flexShrink: 0, width: 40, height: 24, borderRadius: 12, marginTop: 2, position: 'relative',
            background: on ? P.green : P.border,
          }}>
            <span style={{
              position: 'absolute', top: 2, left: on ? 18 : 2, width: 20, height: 20, borderRadius: '50%',
              background: P.white,
            }} />
          </span>
        </button>
      </div>
    </div>
  )
}

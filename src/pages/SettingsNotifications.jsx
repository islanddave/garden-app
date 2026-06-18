// SettingsNotifications — Settings → Notifications page, MVP-Critter Session 4 Phase A.
// Spec: mvp-critter-pre-build-revision-V001 §3.17 (disclosure-button + radio-group ARIA),
// §3.23 (route parent + ErrorBoundary), §3.24 (iOS PWA-installed gate on SYSTEM),
// §6 deferred note (SYSTEM_NOTIFICATIONS_ENABLED literal bi-state).
//
// Phase A scope (no Jen-walkthrough required): tri-state toggle infrastructure +
// read/write user_notification_prefs via Lambda Routes 7+8 + iOS PWA gate + flag.
// NO critter user-facing copy (announcement variants, coachmark, opt-in) — Phase B.
//
// V100 conformance: this surface is NOT a reward delivery surface (it's a config
// page). No ambient/interrupt rules apply directly; standard a11y discipline only.
// Does NOT call Notification.requestPermission() — that opt-in is exclusively via
// explicit user navigation per project CLAUDE.md notification-permission rule.

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { P } from '../lib/constants.js'
import { useApiFetch } from '../lib/api.js'
import { SYSTEM_NOTIFICATIONS_ENABLED } from '../lib/featureFlags.js'
import {
  fetchNotificationPrefs,
  patchNotificationPrefs,
  CRITTER_VISIT_VALUES,
} from '../lib/notificationPrefsClient.js'

const OPTION_LABELS = {
  off:         'Off',
  in_app_only: 'In-app only',
  system:      'System',
}

const OPTION_DESCRIPTIONS = {
  off:         'No critter notifications.',
  in_app_only: 'Critters appear ambiently in the app — never as interruptions.',
  system:      'System notifications when critters arrive (requires Add to Home Screen).',
}

// Detect iOS/Safari PWA-installed state per spec §3.24.
// Returns true when the app is launched from the home screen ("standalone" PWA),
// false otherwise. Used to gate the SYSTEM radio option (push delivery requires
// the PWA install on iOS Safari).
export function isPwaInstalled() {
  if (typeof window === 'undefined') return false
  try {
    if (typeof window.matchMedia === 'function') {
      const mm = window.matchMedia('(display-mode: standalone)')
      if (mm && mm.matches) return true
    }
  } catch { /* ignore */ }
  if (typeof navigator !== 'undefined' && navigator.standalone === true) return true
  return false
}

export default function SettingsNotifications() {
  const { getToken } = useApiFetch()
  const [loading, setLoading] = useState(true)
  const [value, setValue]     = useState('in_app_only')
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [installHelpOpen, setInstallHelpOpen] = useState(false)
  const buttonRef = useRef(null)
  const radioRefs = useRef({})

  // Visible options — when SYSTEM_NOTIFICATIONS_ENABLED is false, SYSTEM is hidden
  // entirely (bi-state collapse to OFF / IN-APP ONLY per §6 deferred note).
  const VISIBLE_OPTIONS = SYSTEM_NOTIFICATIONS_ENABLED
    ? CRITTER_VISIT_VALUES
    : CRITTER_VISIT_VALUES.filter(v => v !== 'system')

  // Initial fetch
  useEffect(() => {
    let on = true
    fetchNotificationPrefs({ getToken }).then(prefs => {
      if (!on) return
      if (prefs && typeof prefs.critter_visit === 'string') {
        const v = prefs.critter_visit
        // Defensive — if SYSTEM flag is off but DB has 'system', collapse to in_app_only
        if (v === 'system' && !SYSTEM_NOTIFICATIONS_ENABLED) {
          setValue('in_app_only')
        } else if (CRITTER_VISIT_VALUES.includes(v)) {
          setValue(v)
        }
      }
      setLoading(false)
    })
    return () => { on = false }
  }, [getToken])

  // Persist selection. Optimistic UI: update local state immediately,
  // POST in background, revert on failure.
  const select = useCallback(async (next) => {
    if (busy || next === value) return
    const prev = value
    setValue(next)
    setBusy(true)
    setAnnouncement(`Critter notifications set to ${OPTION_LABELS[next]}`)
    try {
      const updated = await patchNotificationPrefs({ getToken, critterVisit: next })
      if (!updated) {
        // Revert
        setValue(prev)
        setAnnouncement(`Failed to save. Critter notifications set to ${OPTION_LABELS[prev]}`)
      }
    } finally {
      setBusy(false)
    }
  }, [busy, value, getToken])

  // Keyboard nav per §3.17:
  //   Space/Enter on disclosure button → toggle expanded
  //   Esc inside radiogroup → collapse
  //   ArrowUp/ArrowDown between radios
  const onButtonKey = useCallback((e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      setExpanded(x => !x)
    }
  }, [])

  const onRadioKey = useCallback((e, idx) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setExpanded(false)
      buttonRef.current?.focus()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault()
      const nextIdx = (idx + 1) % VISIBLE_OPTIONS.length
      radioRefs.current[VISIBLE_OPTIONS[nextIdx]]?.focus()
      return
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const nextIdx = (idx - 1 + VISIBLE_OPTIONS.length) % VISIBLE_OPTIONS.length
      radioRefs.current[VISIBLE_OPTIONS[nextIdx]]?.focus()
      return
    }
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      select(VISIBLE_OPTIONS[idx])
    }
  }, [VISIBLE_OPTIONS, select])

  // Focus first radio on expand
  useEffect(() => {
    if (expanded) {
      const target = radioRefs.current[value] ?? radioRefs.current[VISIBLE_OPTIONS[0]]
      target?.focus()
    }
  }, [expanded])

  const pwaInstalled = isPwaInstalled()

  return (
    <div data-testid="settings-notifications-page" style={{
      maxWidth: 600,
      margin: '0 auto',
      padding: '24px 20px 80px',
    }}>
      <h1 style={{ fontSize: '1.4rem', margin: '0 0 4px', color: P.dark }}>
        Notifications
      </h1>
      <p style={{ fontSize: '0.92rem', color: P.light, margin: '0 0 24px' }}>
        How critter visits show up.
      </p>

      <div style={{ borderTop: `1px solid ${P.border}`, paddingTop: 16 }}>
        {/* Disclosure button — §3.17 ARIA contract */}
        <button
          ref={buttonRef}
          type="button"
          aria-expanded={expanded}
          aria-controls="critter-notif-radiogroup"
          aria-disabled={loading}
          onClick={() => !loading && setExpanded(x => !x)}
          onKeyDown={onButtonKey}
          data-testid="critter-notif-disclosure"
          style={{
            width: '100%',
            minHeight: 48,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '12px 14px',
            background: P.white,
            border: `1px solid ${P.border}`,
            borderRadius: 10,
            cursor: loading ? 'progress' : 'pointer',
            fontFamily: 'inherit',
            color: P.dark,
            textAlign: 'left',
          }}
        >
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
            <span style={{ fontSize: '1rem', fontWeight: 600 }}>Critter notifications</span>
            <span style={{ fontSize: '0.82rem', color: P.light }}>
              {loading ? 'Loading…' : OPTION_LABELS[value]}
            </span>
          </span>
          <span aria-hidden="true" style={{
            fontSize: '0.8rem', color: P.light,
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 120ms ease',
          }}>▾</span>
        </button>

        {expanded && (
          <div
            id="critter-notif-radiogroup"
            role="radiogroup"
            aria-label="Critter notifications"
            data-testid="critter-notif-radiogroup"
            style={{
              marginTop: 8,
              padding: '4px 0',
              background: P.white,
              border: `1px solid ${P.border}`,
              borderRadius: 10,
            }}
          >
            {VISIBLE_OPTIONS.map((opt, idx) => {
              const selected = value === opt
              const isSystem = opt === 'system'
              const systemBlocked = isSystem && !pwaInstalled
              return (
                <div key={opt} style={{
                  padding: '12px 14px',
                  borderTop: idx === 0 ? 'none' : `1px solid ${P.border}`,
                }}>
                  {systemBlocked ? (
                    // §3.24 affordance: PWA install required instead of radio
                    <div data-testid={`critter-notif-option-${opt}-blocked`}>
                      <button
                        type="button"
                        onClick={() => setInstallHelpOpen(x => !x)}
                        aria-expanded={installHelpOpen}
                        style={{
                          display: 'flex', alignItems: 'flex-start', gap: 12,
                          width: '100%', minHeight: 44,
                          padding: 0,
                          background: 'none', border: 'none',
                          textAlign: 'left', cursor: 'pointer',
                          fontFamily: 'inherit', color: P.dark,
                        }}
                      >
                        <span aria-hidden="true" style={{
                          width: 20, height: 20, borderRadius: '50%',
                          border: `2px solid ${P.border}`, flexShrink: 0,
                          marginTop: 2,
                          background: '#eee',
                        }} />
                        <span style={{ flex: 1 }}>
                          <span style={{ display: 'block', fontSize: '0.96rem', fontWeight: 600, color: P.light }}>
                            {OPTION_LABELS[opt]}
                          </span>
                          <span style={{ display: 'block', fontSize: '0.82rem', color: P.light, marginTop: 2 }}>
                            Requires Add to Home Screen — tap to learn how
                          </span>
                        </span>
                      </button>
                      {installHelpOpen && (
                        <div data-testid="install-help-expander" style={{
                          marginTop: 10,
                          padding: 12,
                          background: P.cream,
                          borderRadius: 8,
                          fontSize: '0.85rem',
                          color: P.dark,
                          lineHeight: 1.45,
                        }}>
                          <p style={{ margin: '0 0 6px', fontWeight: 600 }}>iOS Safari:</p>
                          <p style={{ margin: '0 0 8px' }}>
                            Tap the Share button at the bottom of Safari, then choose
                            "Add to Home Screen." Open the app from your home screen and
                            return here to enable system notifications.
                          </p>
                          <p style={{ margin: '0 0 6px', fontWeight: 600 }}>Android / Chrome:</p>
                          <p style={{ margin: 0 }}>
                            Open the browser menu (⋮) and choose "Install app" or
                            "Add to Home screen."
                          </p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div
                      role="radio"
                      aria-checked={selected}
                      tabIndex={selected ? 0 : -1}
                      ref={el => { if (el) radioRefs.current[opt] = el }}
                      onClick={() => select(opt)}
                      onKeyDown={(e) => onRadioKey(e, idx)}
                      data-testid={`critter-notif-option-${opt}`}
                      style={{
                        display: 'flex', alignItems: 'flex-start', gap: 12,
                        minHeight: 44,
                        cursor: 'pointer',
                        outline: 'none',
                      }}
                    >
                      <span aria-hidden="true" style={{
                        width: 20, height: 20, borderRadius: '50%',
                        border: `2px solid ${selected ? P.green : P.border}`,
                        flexShrink: 0,
                        marginTop: 2,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: P.white,
                      }}>
                        {selected && (
                          <span style={{
                            width: 10, height: 10, borderRadius: '50%',
                            backgroundColor: P.green,
                          }} />
                        )}
                      </span>
                      <span style={{ flex: 1 }}>
                        <span style={{ display: 'block', fontSize: '0.96rem', fontWeight: selected ? 700 : 500, color: P.dark }}>
                          {OPTION_LABELS[opt]}
                        </span>
                        <span style={{ display: 'block', fontSize: '0.82rem', color: P.light, marginTop: 2 }}>
                          {OPTION_DESCRIPTIONS[opt]}
                        </span>
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Live region for post-selection announcements per §3.17 */}
      <div
        aria-live="polite"
        aria-atomic="true"
        data-testid="critter-notif-announcement"
        style={{
          position: 'absolute',
          width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden',
          clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
        }}
      >
        {announcement}
      </div>

      {/* Focus-visible 3px solid accent ring per §3.17 */}
      <style>{`
        [data-testid="critter-notif-disclosure"]:focus-visible,
        [data-testid="critter-notif-radiogroup"] [role="radio"]:focus-visible {
          outline: 3px solid ${P.green};
          outline-offset: 2px;
          border-radius: 6px;
        }
      `}</style>
    </div>
  )
}

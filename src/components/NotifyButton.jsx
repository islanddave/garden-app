// NotifyButton — dashboard tile that records a push-notification consent preference.
//
// ─── KILL SWITCH ──────────────────────────────────────────────────────────────
// Ships behind a feature flag, default OFF (plan boss-decision B6). Push DELIVERY
// is not built yet — this component only records a permission/consent preference.
// To ENABLE: flip NOTIFY_ENABLED to true below, then redeploy the SPA.
// When disabled, the component renders null (render-level short-circuit, plan B4).
// ──────────────────────────────────────────────────────────────────────────────
//
// Testability: accepts an optional `enabled` prop defaulting to NOTIFY_ENABLED.
// Production callers (Dashboard.jsx) do NOT pass it → resolves to false → renders
// null. Tests pass enabled={true} to exercise the full component.

import React, { useState, useEffect, useRef } from 'react'
import { P } from '../lib/constants.js'
import { useApiFetch } from '../lib/api.js'

const NOTIFY_ENABLED = false

// Engagement gate (plan Q4): hide the button until the user has logged enough
// activity to make a permissions decision meaningful.
const MIN_EVENTS = 3
const MIN_HARVESTS = 1

// Minimal, defensive iOS detection. Used only to swap an actionable button for a
// passive notice when running iOS Safari outside an installed PWA.
function isIOS() {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  // iPad on iPadOS 13+ reports as Mac; the touch-points check disambiguates.
  return /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1)
}

function isStandalonePWA() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(display-mode: standalone)').matches === true ||
      window.navigator.standalone === true
  } catch {
    return false
  }
}

const tileStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '14px 16px',
  backgroundColor: P.white,
  border: `1.5px solid ${P.border}`,
  borderRadius: '10px',
  marginBottom: '12px',
}

const labelStyle = {
  fontSize: '0.75rem',
  color: P.mid,
  fontWeight: 500,
  marginBottom: '1px',
}

export default function NotifyButton({ eventCount = 0, harvestCount = 0, enabled = NOTIFY_ENABLED }) {
  // Resolve permission lazily so the test stub of window.Notification is honored.
  const [permission, setPermission] = useState(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      return window.Notification.permission
    }
    return 'default'
  })
  const [saveError, setSaveError] = useState(false)
  const [howToOpen, setHowToOpen] = useState(false)
  const [requesting, setRequesting] = useState(false)

  const { fetch: apiFetch } = useApiFetch()

  // Guard against setState after unmount once requestPermission() resolves.
  const isMounted = useRef(true)
  useEffect(() => {
    isMounted.current = true
    return () => { isMounted.current = false }
  }, [])

  // ─── Kill switch ────────────────────────────────────────────────────────────
  if (!enabled) return null

  // ─── Capability gate ────────────────────────────────────────────────────────
  // Push API unavailable (e.g. iOS Safari outside a PWA) → nothing to show.
  if (typeof window !== 'undefined' && !('Notification' in window)) return null

  // ─── Engagement gate ────────────────────────────────────────────────────────
  // Avoid front-loading a permissions decision before the user is invested.
  if (eventCount < MIN_EVENTS && harvestCount < MIN_HARVESTS) return null

  // ─── iOS Safari non-PWA passive notice ──────────────────────────────────────
  if (isIOS() && !isStandalonePWA()) {
    return (
      <div style={tileStyle} data-testid="notify-button">
        <span style={{ fontSize: '1.4rem' }}>🔔</span>
        <div>
          <div style={labelStyle}>REMINDERS</div>
          <div style={{ fontWeight: 600, color: P.dark, fontSize: '0.9rem' }}>
            Reminders work best in the installed app
          </div>
        </div>
      </div>
    )
  }

  async function handleEnable() {
    if (requesting) return
    setRequesting(true)
    setSaveError(false)
    let result
    try {
      result = await window.Notification.requestPermission()
    } catch {
      // requestPermission threw — treat as no decision, stay in default state.
      if (isMounted.current) setRequesting(false)
      return
    }
    if (!isMounted.current) return

    // iOS Safari can resolve to 'default' if the user dismisses the prompt —
    // handle gracefully: no error, just stay in the default state.
    setPermission(result)

    if (result === 'granted') {
      try {
        await apiFetch('/api/notifications/subscribe', {
          method: 'POST',
          body: JSON.stringify({ permission_state: result }),
        })
        if (isMounted.current) setSaveError(false)
      } catch (err) {
        // useApiFetch throws on non-2xx; err carries .status and .body.
        console.error('NotifyButton: failed to save notification preference', err?.body ?? err)
        if (isMounted.current) setSaveError(true)
      }
    }
    if (isMounted.current) setRequesting(false)
  }

  // Inline error notice — shown whenever the most recent preference save failed.
  // Rendered in both the granted and default states (a granted-permission POST
  // that fails still leaves permission === 'granted').
  const errorNotice = saveError ? (
    <div
      role="alert"
      data-testid="notify-error"
      style={{
        fontSize: '0.82rem',
        color: P.terra,
        backgroundColor: P.alert,
        border: `1px solid ${P.alertBorder}`,
        borderRadius: 6,
        padding: '6px 10px',
      }}
    >
      Couldn't save preference — try again
    </div>
  ) : null

  // ─── Granted: passive "Reminders on" state ──────────────────────────────────
  if (permission === 'granted') {
    return (
      <div
        style={{ ...tileStyle, flexDirection: 'column', alignItems: 'stretch', gap: 8 }}
        data-testid="notify-button"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: '1.4rem' }}>🔔</span>
          <div>
            <div style={labelStyle}>REMINDERS</div>
            <div style={{ fontWeight: 700, color: P.green, fontSize: '0.95rem' }}>
              Reminders on
            </div>
          </div>
        </div>
        {errorNotice}
      </div>
    )
  }

  // ─── Denied: blocked state + expandable how-to ──────────────────────────────
  if (permission === 'denied') {
    return (
      <div
        style={{ ...tileStyle, flexDirection: 'column', alignItems: 'stretch', gap: 8 }}
        data-testid="notify-button"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: '1.4rem' }}>🔕</span>
          <div>
            <div style={labelStyle}>REMINDERS</div>
            <div style={{ fontWeight: 700, color: P.terra, fontSize: '0.95rem' }}>
              Reminders blocked
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setHowToOpen(o => !o)}
          aria-expanded={howToOpen}
          style={{
            alignSelf: 'flex-start',
            minHeight: 44,
            background: 'transparent',
            border: 'none',
            color: P.green,
            fontSize: '0.85rem',
            fontWeight: 600,
            cursor: 'pointer',
            padding: '4px 0',
            textAlign: 'left',
          }}
        >
          {howToOpen ? 'How to enable ▾' : 'How to enable ▸'}
        </button>
        {howToOpen && (
          <ol
            data-testid="notify-howto"
            style={{
              margin: 0,
              paddingLeft: 20,
              fontSize: '0.82rem',
              color: P.mid,
              lineHeight: 1.5,
            }}
          >
            <li>Open your browser or site settings for this page.</li>
            <li>Find the Notifications permission and switch it to Allow.</li>
            <li>Reload this page — the reminders option will reappear.</li>
          </ol>
        )}
      </div>
    )
  }

  // ─── Default: actionable "Enable reminders" button ──────────────────────────
  return (
    <div
      style={{ ...tileStyle, flexDirection: 'column', alignItems: 'stretch', gap: 8 }}
      data-testid="notify-button"
    >
      <button
        type="button"
        onClick={handleEnable}
        disabled={requesting}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          minHeight: 44,
          textAlign: 'left',
          padding: '4px 0',
          background: 'transparent',
          border: 'none',
          cursor: requesting ? 'default' : 'pointer',
        }}
      >
        <span style={{ fontSize: '1.4rem' }}>🔔</span>
        <div>
          <div style={labelStyle}>REMINDERS</div>
          <div style={{ fontWeight: 700, color: P.green, fontSize: '0.95rem' }}>
            Enable reminders
          </div>
        </div>
      </button>
      {errorNotice}
    </div>
  )
}

// AdminConfig — V5-ADMINCENTER-001. Configure the app from inside the app; first capability is the
// order of the bottom nav's tabs. Design: project-state/design-admincentre-V100-20260908.md.
//
// WHY IT IS AT /admin/config AND NOT UNDER /settings. DebugMenu.reachability.test.jsx fails the
// build if an /admin/<segment> route has no row in DebugMenu's LINKS. Dave runs an installed PWA
// with no address bar, so an unlinked page is not "reachable by URL", it is unreachable — that is
// the defect OPS-DEBUGMENU-001 exists to catch, and putting this surface under /admin/* inherits the
// guard automatically. /settings/admin would have escaped it and could have shipped with no door.
//
// AUTHORIZATION IS SERVER-SIDE AND THERE IS NO CLIENT ADMIN LIST. That is a documented decision
// repeated in three files (DebugMenu.jsx:18-26, GardenActivity.jsx, useShareToFacebook.js): the real
// gate is the Lambda's ADMIN_CLERK_SUBS allowlist, fail-closed. So this page renders its editor for
// whoever opens it and the WRITE is what gets refused — a 403 from the PATCH swaps the whole surface
// to the same neutral placard GardenActivity shows (GardenActivity.jsx:179-186), revealing nothing.
// Do NOT add a client-side admin check here to hide the page earlier; it would reverse that call and
// buy nothing, because the client list would be the thing an attacker edits.
//
// V1 IS REORDER-ONLY. Hiding a tab removes the only door to a page — the same class of defect the
// reachability gate above exists to catch, arriving through a different route — and the
// hide-vs-reorder ruling is reserved for Dave (design §7), unanswered as of 2026-09-08. The
// enforcement is not in this UI: resolveNavTabs accepts a permutation of the shipped five and
// nothing else, so even a hand-written database value cannot empty the bar.
//
// ⚠️ THE SAVE IS INERT UNTIL THE COLUMN LANDS, and the page says so instead of pretending.
// user_notification_prefs.nav_tabs is authored and NOT applied (migrations/v5-admincenter-001), and
// the critter Lambda's HAS_UPDATABLE allowlist does not carry the key yet, so today the PATCH comes
// back 400. This is the same posture V4-HANDEDNESSCONTROLS-001 shipped in on the same table. The
// page needs no change when the column and the Lambda land — it starts saving.
import React, { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { P } from '../lib/constants.js'
import Icon from '../components/Icon.jsx'
import { useApiFetch } from '../lib/api.js'
import { usePrefs } from '../context/PrefsContext.jsx'
import { DEFAULT_NAV_TABS, TAB_REGISTRY, resolveNavTabs } from '../lib/navConfig.js'
import { saveNavTabs } from '../lib/notificationPrefsClient.js'

const card = {
  background: P.white, border: `1px solid ${P.border}`, borderRadius: 10,
  padding: '12px 14px', marginBottom: 12,
}

// Same copy and posture as GardenActivity's placard: a non-admin learns nothing about the surface.
function NeutralPlacard() {
  return (
    <div role="status" style={{ padding: '48px 20px', textAlign: 'center', color: P.light }}>
      <p>Nothing to see here.</p>
    </div>
  )
}

function MoveButton({ label, glyph, onClick, disabled }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      style={{
        minWidth: 44, minHeight: 44, borderRadius: 8, border: `1px solid ${P.border}`,
        background: disabled ? P.cream : P.white, color: disabled ? P.light : P.dark,
        fontSize: '1.1rem', fontFamily: 'inherit', cursor: disabled ? 'default' : 'pointer',
      }}
    >{glyph}</button>
  )
}

export default function AdminConfig() {
  const { getToken } = useApiFetch()
  const { prefs, refreshPrefs } = usePrefs()
  // Seeded from the resolved config, so the editor opens on exactly what the bar is rendering —
  // including the fallback, when the stored value is missing or malformed.
  const saved = useMemo(() => resolveNavTabs(prefs?.nav_tabs), [prefs])
  const [order, setOrder] = useState(saved)
  const [status, setStatus] = useState(null)   // null | 'saving' | {ok, detail}
  const [forbidden, setForbidden] = useState(false)

  const move = useCallback((from, to) => {
    setOrder(prev => {
      if (to < 0 || to >= prev.length) return prev
      const next = [...prev]
      const [row] = next.splice(from, 1)
      next.splice(to, 0, row)
      return next
    })
    setStatus(null)
  }, [])

  const dirty = order.join(',') !== saved.join(',')

  const onSave = useCallback(async () => {
    setStatus('saving')
    const res = await saveNavTabs({ getToken, tabs: order })
    if (res.ok) {
      // Re-read rather than trusting the echo, so the bar and this page agree on one source.
      await refreshPrefs()
      setStatus({ ok: true, detail: 'Saved. The tab bar picks it up next time the app starts.' })
      return
    }
    if (res.status === 403) { setForbidden(true); return }
    setStatus({
      ok: false,
      detail: res.status === 400
        // Named exactly, because "save failed" would send the next session hunting a bug that is not
        // there: the column and the Lambda allowlist are both pending by design.
        ? 'Not saved — the server does not accept this setting yet (migrations/v5-admincenter-001 is authored, not applied).'
        : res.status === 401 ? 'Not saved — not signed in.'
        : res.status === 0 ? 'Not saved — could not reach the server.'
        : `Not saved — server returned ${res.status}.`,
    })
  }, [getToken, order, refreshPrefs])

  if (forbidden) return <NeutralPlacard />

  return (
    <div style={{ padding: 16, paddingBottom: 40, maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: P.dark, marginBottom: 2 }}>App configuration</h1>
      <p style={{ fontSize: '0.84rem', color: P.light, marginTop: 0, marginBottom: 16 }}>
        Settings that change how the app is put together, rather than what it holds.
      </p>

      <h2 style={{ fontSize: '0.78rem', fontWeight: 700, color: P.light, letterSpacing: '0.05em', textTransform: 'uppercase', margin: '20px 0 8px' }}>
        Tab bar order
      </h2>

      <div style={card} data-testid="nav-order-editor">
        {order.map((key, i) => (
          <div
            key={key}
            data-testid="nav-order-row"
            data-tab-key={key}
            style={{
              display: 'flex', alignItems: 'center', gap: 12, minHeight: 52,
              borderTop: i === 0 ? 'none' : `1px solid ${P.border}`, padding: '4px 0',
            }}
          >
            <Icon name={TAB_REGISTRY[key].iconName} size={22} decorative style={{ flexShrink: 0, color: P.dark }} />
            <span style={{ flex: 1, minWidth: 0, fontSize: '0.95rem', fontWeight: 600, color: P.dark }}>
              {TAB_REGISTRY[key].label}
            </span>
            <MoveButton label={`Move ${TAB_REGISTRY[key].label} up`} glyph="↑" disabled={i === 0} onClick={() => move(i, i - 1)} />
            <MoveButton label={`Move ${TAB_REGISTRY[key].label} down`} glyph="↓" disabled={i === order.length - 1} onClick={() => move(i, i + 1)} />
          </div>
        ))}
      </div>

      <p style={{ fontSize: '0.78rem', color: P.light, lineHeight: 1.4, marginTop: 0 }}>
        Every tab keeps its place in the bar — this changes the order only. “More” always sits last.
      </p>

      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || status === 'saving'}
          style={{
            flex: 1, minHeight: 44, borderRadius: 8, border: `1px solid ${P.border}`,
            background: dirty ? P.green : P.cream, color: dirty ? '#fff' : P.light,
            fontSize: '0.95rem', fontWeight: 600, fontFamily: 'inherit',
            cursor: dirty && status !== 'saving' ? 'pointer' : 'default',
          }}
        >
          {status === 'saving' ? 'Saving…' : 'Save order'}
        </button>
        <button
          type="button"
          onClick={() => { setOrder(DEFAULT_NAV_TABS); setStatus(null) }}
          style={{
            minHeight: 44, padding: '0 16px', borderRadius: 8, border: `1px solid ${P.border}`,
            background: P.white, color: P.dark, fontSize: '0.95rem', fontWeight: 600,
            fontFamily: 'inherit', cursor: 'pointer',
          }}
        >
          Reset
        </button>
      </div>

      {status && status !== 'saving' && (
        <p role="status" style={{ fontSize: '0.84rem', marginTop: 12, color: status.ok ? P.green : P.terra }}>
          {status.detail}
        </p>
      )}

      <Link
        to="/admin"
        style={{
          display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none',
          color: P.dark, ...card, minHeight: 44, marginTop: 24,
        }}
      >
        <Icon name="nav.back" size={20} decorative style={{ flexShrink: 0 }} />
        <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>Back to Debug &amp; smoke</span>
      </Link>
    </div>
  )
}

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
// THE SETTING IS GLOBAL, AND THE COPY BELOW SAYS SO. Dave ruled 2026-09-08 that there is one nav
// order for the installation, not one per person — so a save here changes Jen's bar too. The first
// implementation of this page wrote user_notification_prefs.nav_tabs, a per-user row that cannot
// hold an installation-wide fact; it now writes public.app_config, which already existed in prod as
// a global key/value store and needed no migration at all. migrations/v5-admincenter-001 was
// WITHDRAWN rather than rewritten: there was never any DDL to apply.
//
// Because the store is shared, the ADMIN_CLERK_SUBS gate is a PREREQUISITE of this page rather than
// an adjacent tidy-up. Under the old per-user store the write bound created_by to the caller's own
// token id, so every write was self-scoped by construction and an ungated route was harmless. A
// self-scoped write to a shared row is not self-scoped.
import React, { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { P } from '../lib/constants.js'
import Icon from '../components/Icon.jsx'
import { useApiFetch } from '../lib/api.js'
import { useAppConfig } from '../context/AppConfigContext.jsx'
import { DEFAULT_NAV_TABS, TAB_REGISTRY, resolveNavTabs } from '../lib/navConfig.js'
import { saveNavTabs } from '../lib/appConfigClient.js'

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
  const { appConfig, refreshAppConfig } = useAppConfig()
  // Seeded from the resolved config, so the editor opens on exactly what the bar is rendering —
  // including the fallback, when the stored value is missing or malformed.
  const saved = useMemo(() => resolveNavTabs(appConfig?.nav_tabs), [appConfig])
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
      await refreshAppConfig()
      setStatus({ ok: true, detail: 'Saved. Every tab bar picks it up next time the app starts.' })
      return
    }
    // 403 is the SERVER saying "not an admin" — including the fail-closed case where
    // ADMIN_CLERK_SUBS is simply not set on the critter Lambda, which refuses everyone. Both land on
    // the neutral placard: a non-admin learns nothing about the surface either way.
    if (res.status === 403) { setForbidden(true); return }
    setStatus({
      ok: false,
      detail: res.status === 400
        // Named exactly, because "save failed" would send the next session hunting a bug. The route
        // refuses anything that is not a permutation of the shipped five — v1 is reorder-only.
        ? 'Not saved — the server rejected this order.'
        : res.status === 401 ? 'Not saved — not signed in.'
        : res.status === 0 ? 'Not saved — could not reach the server.'
        : `Not saved — server returned ${res.status}.`,
    })
  }, [getToken, order, refreshAppConfig])

  if (forbidden) return <NeutralPlacard />

  return (
    <div style={{ padding: 16, paddingBottom: 40, maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: P.dark, marginBottom: 2 }}>App configuration</h1>
      <p style={{ fontSize: '0.84rem', color: P.light, marginTop: 0, marginBottom: 16 }}>
        Settings that change how the app is put together, rather than what it holds. These apply to
        the whole app, for everyone who uses it.
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
        This is the order for everyone using the app, not just for you.
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

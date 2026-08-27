// src/pages/DebugMenu.jsx — OPS-DEBUGMENU-001. The index for every diagnostic surface in the app.
//
// WHY THIS EXISTS, stated plainly because the gap it closes was mine: three admin routes
// (/admin/classify, /admin/garden-activity, /admin/voice-debug) were built unlinked by convention —
// "Jen-invisible, reachable by URL" — which is a perfectly good rule on a desktop and a DEAD END in
// an installed PWA. There is no address bar. Dave runs this app from the home screen on Android, so
// "unlinked" has meant "unreachable" for every one of them, and a session shipped him a voice probe
// on /admin/voice-debug and then twice told him to navigate to a URL he had no way to type.
// Dave 2026-08-27: "stop telling me to go to urls - if the voice probe has no way to navigate to it
// in the pwa, add a Debug / Smoke menu with quick links we can build in."
//
// SO THE RULE CHANGES, and it is worth being precise about how: a diagnostic page may still be
// UNLINKED FROM ORDINARY NAVIGATION, but it must be reachable from HERE. "Unlinked" is now a
// statement about the main nav, not about existence. A new /admin/* route that does not get a row on
// this page is a page only a desktop browser can open, which on this app's actual platform means a
// page nobody can open.
//
// GATING — deliberately NONE on the client, and that is a followed convention rather than an
// oversight. GardenActivity.jsx and useShareToFacebook.js both record the same decision: the real
// gate is the Lambda's server-side ADMIN_CLERK_SUBS allowlist (fail-closed), and there is NO client
// admin list. Inventing one here to hide a menu row would contradict a documented call and buy
// nothing — the row is discoverability, not authorisation. What each destination shows is already
// gated at its own level: voice-debug reads only this browser's own localStorage, garden-activity
// renders a 403 placard for a non-admin, classify writes through an admin-gated route.
// Dave 2026-08-27: "this is still only me using it right now." If Jen ever finds the row noisy the
// clean fix is a server-gated owner signal, NOT a hardcoded client list.
//
// SMOKE, not just links. Dave asked for "Debug / Smoke", and on a phone the smoke half is the part
// he genuinely cannot get any other way: version, service-worker state, and whether the API is
// answering are all things a session checks with curl from a laptop and he has no equivalent for.
// Every value here is read live at render, never cached, so a stale panel cannot report a healthy
// app that is not.
import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { P } from '../lib/constants.js'
import Icon from '../components/Icon.jsx'
import { useApiFetch } from '../lib/api.js'

const APP_VERSION = (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null) || '0.0.0'

// Every diagnostic surface in the app. ADD A ROW HERE when you add an /admin/* route — see the
// header note on why a missing row means an unreachable page.
const LINKS = [
  {
    to: '/admin/voice-debug',
    icon: 'media.mic',
    label: 'Voice debug + continuous probe',
    blurb: 'Raw Web Speech events, and the BD-068 hands-free harvest probe',
  },
  {
    to: '/admin/garden-activity',
    icon: 'nav.dashboard',
    label: 'Garden activity',
    blurb: 'Household activity metrics (server-gated — shows a placard if not admin)',
  },
  {
    to: '/admin/classify',
    icon: 'facet.type',
    label: 'Project classify',
    blurb: 'Bulk crop-type classification for projects',
  },
  {
    to: '/releases',
    icon: 'action.info',
    label: 'Release notes',
    blurb: "What shipped, and when — the app's own changelog",
  },
  {
    to: '/about',
    icon: 'action.info',
    label: 'About',
    blurb: 'Build info and credits',
  },
]

function Row({ label, value, tone }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 0', alignItems: 'baseline' }}>
      <span style={{ fontSize: '0.82rem', color: P.mid, flexShrink: 0 }}>{label}</span>
      <span style={{
        fontSize: '0.82rem', fontWeight: 600, textAlign: 'right', wordBreak: 'break-word',
        color: tone === 'bad' ? P.terra : tone === 'good' ? P.green : P.dark,
      }}>{value}</span>
    </div>
  )
}

export default function DebugMenu() {
  const { fetch: apiFetch } = useApiFetch()
  const [sw, setSw] = useState('checking…')
  const [swVersion, setSwVersion] = useState('—')
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  const [storage, setStorage] = useState('—')
  const [ping, setPing] = useState(null)   // null | 'running' | {ok, ms, detail}

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  useEffect(() => {
    let alive = true
    if (!('serviceWorker' in navigator)) { setSw('unsupported'); return }
    navigator.serviceWorker.getRegistration()
      .then(reg => {
        if (!alive) return
        if (!reg) { setSw('none registered'); return }
        const w = reg.active || reg.waiting || reg.installing
        setSw(reg.waiting ? 'update waiting' : reg.active ? 'active' : w ? w.state : 'unknown')
      })
      .catch(() => { if (alive) setSw('lookup failed') })

    // The SW's own stamped version, fetched fresh. This is the value that actually proves WHICH
    // build is serving — the bundle constant above says what the JS thinks it is, and the two can
    // disagree while a stale worker is still in charge, which is the exact confusion worth surfacing.
    window.fetch('/sw.js', { cache: 'no-store' })
      .then(r => r.text())
      .then(t => { if (alive) setSwVersion(t.match(/v\d+\.\d+\.\d+-[a-f0-9]+/)?.[0] ?? 'not stamped') })
      .catch(() => { if (alive) setSwVersion('unreachable') })

    navigator.storage?.estimate?.()
      .then(e => {
        if (!alive || !e?.usage) return
        setStorage(`${(e.usage / 1048576).toFixed(1)} MB used`)
      })
      .catch(() => {})

    return () => { alive = false }
  }, [])

  // A real authenticated round-trip, on demand rather than on mount: this is the one check that
  // costs something, and firing it on every visit would make opening the page a write to the rate
  // limiter. /api/members is the cheapest authenticated read that proves the whole chain — token
  // acquisition, Lambda, and Neon — rather than just that something answered.
  const runPing = useCallback(async () => {
    setPing('running')
    const t0 = Date.now()
    try {
      await apiFetch('/api/members')
      setPing({ ok: true, ms: Date.now() - t0 })
    } catch (e) {
      setPing({ ok: false, ms: Date.now() - t0, detail: e?.message ?? String(e) })
    }
  }, [apiFetch])

  const standalone = typeof window !== 'undefined' && (
    window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator.standalone === true
  )

  const card = {
    background: P.white, border: `1px solid ${P.border}`, borderRadius: 10,
    padding: '12px 14px', marginBottom: 12,
  }

  return (
    <div style={{ padding: 16, paddingBottom: 40, maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: P.dark, marginBottom: 2 }}>Debug &amp; smoke</h1>
      <p style={{ fontSize: '0.84rem', color: P.light, marginTop: 0, marginBottom: 16 }}>
        Every diagnostic surface, reachable without an address bar.
      </p>

      <div style={card}>
        <Row label="App build" value={`v${APP_VERSION}`} />
        <Row label="Service worker" value={sw} tone={sw === 'active' ? 'good' : sw === 'update waiting' ? 'bad' : undefined} />
        <Row label="SW stamp" value={swVersion} />
        <Row label="Network" value={online ? 'online' : 'OFFLINE'} tone={online ? 'good' : 'bad'} />
        <Row label="Display mode" value={standalone ? 'installed PWA' : 'browser tab'} />
        <Row label="Storage" value={storage} />
        <Row
          label="API round-trip"
          value={ping === null ? 'not run'
            : ping === 'running' ? 'running…'
            : ping.ok ? `OK in ${ping.ms}ms`
            : `FAILED in ${ping.ms}ms — ${ping.detail}`}
          tone={ping && ping !== 'running' ? (ping.ok ? 'good' : 'bad') : undefined}
        />
        <button
          type="button"
          onClick={runPing}
          disabled={ping === 'running'}
          style={{
            marginTop: 10, minHeight: 44, width: '100%', borderRadius: 8, border: `1px solid ${P.border}`,
            background: P.cream, color: P.dark, fontSize: '0.95rem', fontWeight: 600,
            fontFamily: 'inherit', cursor: ping === 'running' ? 'wait' : 'pointer',
          }}
        >
          {ping === 'running' ? 'Pinging…' : 'Ping the API'}
        </button>
      </div>

      <h2 style={{ fontSize: '0.78rem', fontWeight: 700, color: P.light, letterSpacing: '0.05em', textTransform: 'uppercase', margin: '20px 0 8px' }}>
        Diagnostic pages
      </h2>

      {LINKS.map(l => (
        <Link
          key={l.to}
          to={l.to}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 12, textDecoration: 'none',
            // BUG-LINKICONBLUE-001 — see CultivationLead.jsx for the full note. Every icon on this
            // page is a mono glyph, so without an explicit ink the whole column renders in browser
            // link blue. This is the row that made the bug visible.
            color: P.dark,
            ...card, minHeight: 44,
          }}
        >
          <Icon name={l.icon} size={22} decorative style={{ flexShrink: 0, marginTop: 2 }} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: '0.95rem', fontWeight: 600, color: P.dark }}>{l.label}</span>
            <span style={{ display: 'block', fontSize: '0.78rem', color: P.light, lineHeight: 1.4, marginTop: 2 }}>{l.blurb}</span>
          </span>
        </Link>
      ))}
    </div>
  )
}

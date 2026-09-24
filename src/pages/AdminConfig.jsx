// AdminConfig — "Your tab bar". V5-ADMINCENTER-001 made the bar's order editable; V5-NAVCUSTOM-001
// made it PERSONAL and let Garden, Harvests and Put-Up move into More.
// Design: project-state/design-navcustom-V100-20260924.md §8 (binding over §1–§3).
//
// WHOSE BAR (D4, Dave 2026-09-24: "only my bar changes"). The Save writes the CALLER's own
// user_notification_prefs.bar_layout and nobody else's, so Jen's bar never shifts because of it. The
// copy below says so. This reverses V5-ADMINCENTER-001's global app_config order, whose "tell Jen"
// copy and admin-gated write are gone with it.
//
// WHO SEES IT (D3). The server computes can_edit_bar per request (isAdmin over ADMIN_CLERK_SUBS,
// fail-closed) and sends it with the prefs read; today that is Dave only. Anyone else — including a
// person who follows the Debug & smoke row here — gets the same neutral placard GardenActivity shows.
// There is STILL NO CLIENT ADMIN LIST: the flag is the server's answer, and the write itself is
// self-scoped and not admin-gated (a person can only ever change their own bar), so hiding the page is
// discoverability, not authorisation. Do not add a client-side list to "hide it earlier".
//
// WHERE IT IS. /admin/config, because DebugMenu.reachability.test.jsx fails the build if an /admin/*
// route has no row in DebugMenu's LINKS — Dave runs an installed PWA with no address bar. The More
// sheet's "Edit tab bar" header button is the everyday door; Debug & smoke → App configuration stays
// as the second one.
//
// A TAB THAT LEAVES THE BAR LANDS IN MORE. "In bar" is offered on the three movable tabs only; Today
// and ＋ always stay (Today is where the app opens, ＋ is the only door to the create sheet and, in
// field mode, to Field capture). Unticked tabs keep their place in the order, so ticking one back puts
// it where it was. The enforcement is resolveBarLayout and the Lambda validator, not this UI.
//
// THE STALE-SEED BUG, FIXED. V5-ADMINCENTER-001 seeded the editor once, from whatever config was on
// hand — the shipped default when the read was slow — so a Save could wipe the stored layout with a
// value nobody chose. Now the editor follows the SERVER's value until the person edits, and Save stays
// disabled until that value has been read. If the read failed, Save stays disabled and one line says
// the current bar could not be read.
import React, { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { P } from '../lib/constants.js'
import Icon from '../components/Icon.jsx'
import { useApiFetch } from '../lib/api.js'
import { usePrefs } from '../context/PrefsContext.jsx'
import { useNavLayout } from '../context/NavPrefsContext.jsx'
import { DEFAULT_NAV_TABS, MOVABLE_TAB_KEYS, TAB_REGISTRY, resolveBarLayout } from '../lib/navConfig.js'
import { saveBarLayout } from '../lib/notificationPrefsClient.js'

const card = {
  background: P.white, border: `1px solid ${P.border}`, borderRadius: 10,
  padding: '12px 14px', marginBottom: 12,
}

// Same copy and posture as GardenActivity's placard: a person without the editor learns nothing.
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

// A picture of the bar the draft would give THIS person, More last — the thing they are deciding.
function BarPreview({ bar }) {
  return (
    <div
      data-testid="bar-preview"
      aria-label="Your bar after saving"
      role="img"
      style={{ display: 'flex', border: `1px solid ${P.border}`, borderRadius: 10, overflow: 'hidden', background: P.white }}
    >
      {[...bar, 'more'].map(key => {
        const tab = key === 'more' ? { label: 'More', iconName: 'nav.more' } : TAB_REGISTRY[key]
        return (
          <div
            key={key}
            data-testid="bar-preview-slot"
            data-tab-key={key}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '6px 0', minWidth: 0 }}
          >
            <Icon name={tab.iconName} variant={tab.highlight || key === 'more' ? undefined : 'filled'} size={20} decorative />
            <span style={{ fontSize: '0.62rem', color: P.mid, whiteSpace: 'nowrap' }}>{tab.label}</span>
          </div>
        )
      })}
    </div>
  )
}

const sameLayout = (a, b) =>
  a.order.join(',') === b.order.join(',') && [...a.hidden].sort().join(',') === [...b.hidden].sort().join(',')

export default function AdminConfig() {
  const { getToken } = useApiFetch()
  const { prefs, prefsLoaded, refreshPrefs } = usePrefs()
  const { layout: current, canEditBar, applyLayout } = useNavLayout()

  // A 200 on this visit's own Save IS the server's value — the PATCH stored exactly that layout — so it
  // stays the editor's server value for the rest of the visit, whatever the re-read after it returns.
  // A failed re-read (null) must not turn a saved bar into "could not be read" and disable Save for
  // good (QA MINOR-1), and a re-read that joined a GET issued BEFORE the Save must not roll the editor
  // back to the old bar (regression M5; the bar cache has the same guard in NavPrefsContext).
  const [savedLayout, setSavedLayout] = useState(null)
  // What the server holds, once read. Until then the editor shows the bar this device is drawing.
  const serverLayout = useMemo(
    () => savedLayout ?? (prefsLoaded && prefs ? resolveBarLayout(prefs.bar_layout) : null),
    [savedLayout, prefs, prefsLoaded],
  )
  const base = serverLayout ?? current
  // null until the person edits: an untouched editor follows the server value as it arrives.
  const [draft, setDraft] = useState(null)
  const shown = draft ?? { order: base.order, hidden: base.hidden }
  const preview = resolveBarLayout(shown)
  const [status, setStatus] = useState(null)   // null | 'saving' | {ok, detail}

  const edit = useCallback((fn) => {
    setDraft(prev => fn(prev ?? { order: [...base.order], hidden: [...base.hidden] }))
    setStatus(null)
  }, [base])

  const move = useCallback((from, to) => edit(d => {
    if (to < 0 || to >= d.order.length) return d
    const order = [...d.order]
    const [key] = order.splice(from, 1)
    order.splice(to, 0, key)
    return { ...d, order }
  }), [edit])

  const setInBar = useCallback((key, inBar) => edit(d => ({
    ...d,
    hidden: inBar ? d.hidden.filter(k => k !== key) : (d.hidden.includes(key) ? d.hidden : [...d.hidden, key]),
  })), [edit])

  const readFailed = prefsLoaded && !prefs && !savedLayout
  const dirty = serverLayout ? !sameLayout(shown, serverLayout) : draft != null
  const canSave = !!serverLayout && dirty && status !== 'saving'

  const onSave = useCallback(async () => {
    setStatus('saving')
    const layout = { order: [...shown.order], hidden: [...shown.hidden] }
    const res = await saveBarLayout({ getToken, layout })
    if (res.ok) {
      applyLayout(layout)
      setSavedLayout(resolveBarLayout(layout))
      await refreshPrefs()
      setDraft(null)
      setStatus({ ok: true, detail: 'Saved. Your tab bar has changed.' })
      return
    }
    setStatus({
      ok: false,
      detail: res.status === 400 ? 'Not saved — the server rejected this layout.'
        : res.status === 401 ? 'Not saved — not signed in.'
        : res.status === 0 ? 'Not saved — could not reach the server.'
        : `Not saved — server returned ${res.status}.`,
    })
  }, [getToken, shown, applyLayout, refreshPrefs])

  if (canEditBar !== true) return <NeutralPlacard />

  return (
    <div style={{ padding: 16, paddingBottom: 40, maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: P.dark, marginBottom: 2 }}>Your tab bar</h1>
      <p style={{ fontSize: '0.84rem', color: P.light, marginTop: 0, marginBottom: 16 }}>
        This changes your tab bar only — nobody else’s. A tab you take out of the bar moves to the top
        of “Your garden” in More.
      </p>

      <div style={card} data-testid="nav-order-editor">
        {shown.order.map((key, i) => {
          const tab = TAB_REGISTRY[key]
          const movable = MOVABLE_TAB_KEYS.includes(key)
          const inBar = !shown.hidden.includes(key)
          return (
            <div
              key={key}
              data-testid="nav-order-row"
              data-tab-key={key}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, minHeight: 52,
                borderTop: i === 0 ? 'none' : `1px solid ${P.border}`, padding: '4px 0',
              }}
            >
              <Icon name={tab.iconName} size={22} decorative style={{ flexShrink: 0, color: P.dark }} />
              <span style={{ flex: 1, minWidth: 0, fontSize: '0.95rem', fontWeight: 600, color: inBar ? P.dark : P.light }}>
                {tab.label}
              </span>
              {movable ? (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 44, fontSize: '0.84rem', color: P.dark, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={inBar}
                    onChange={e => setInBar(key, e.target.checked)}
                    aria-label={`${tab.label} in bar`}
                    style={{ width: 20, height: 20, margin: 0, accentColor: P.green }}
                  />
                  In bar
                </label>
              ) : (
                <span data-testid="nav-order-fixed" style={{ fontSize: '0.78rem', color: P.light }}>Always in bar</span>
              )}
              <MoveButton label={`Move ${tab.label} up`} glyph="↑" disabled={i === 0} onClick={() => move(i, i - 1)} />
              <MoveButton label={`Move ${tab.label} down`} glyph="↓" disabled={i === shown.order.length - 1} onClick={() => move(i, i + 1)} />
            </div>
          )
        })}
      </div>

      <h2 style={{ fontSize: '0.78rem', fontWeight: 700, color: P.light, letterSpacing: '0.05em', textTransform: 'uppercase', margin: '20px 0 8px' }}>
        Your bar after saving
      </h2>
      <BarPreview bar={preview.bar} />
      <p style={{ fontSize: '0.78rem', color: P.light, lineHeight: 1.4, marginTop: 8 }}>
        {preview.moved.length
          ? `In More, at the top of “Your garden”: ${preview.moved.map(k => TAB_REGISTRY[k].label).join(', ')}.`
          : 'Every tab is in the bar.'} “More” always sits last.
      </p>

      {readFailed && (
        <p data-testid="bar-read-failed" style={{ fontSize: '0.84rem', color: P.terra, marginTop: 12 }}>
          Your current tab bar could not be read, so it can’t be saved right now.
        </p>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          style={{
            flex: 1, minHeight: 44, borderRadius: 8, border: `1px solid ${P.border}`,
            background: canSave ? P.green : P.cream, color: canSave ? P.white : P.light,
            fontSize: '0.95rem', fontWeight: 600, fontFamily: 'inherit',
            cursor: canSave ? 'pointer' : 'default',
          }}
        >
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => { setDraft({ order: [...DEFAULT_NAV_TABS], hidden: [] }); setStatus(null) }}
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

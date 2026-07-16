import React, { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import WhatsNewDot from './WhatsNewDot.jsx'
import { P } from '../lib/constants.js'
import CatchUpBadge from './CatchUpBadge.jsx'
import { CATCH_UP_EDITOR_SHIPPED } from '../lib/featureFlags.js'
import { useApiFetch } from '../lib/api.js'
import BottomNavDot from './BottomNavDot.jsx'
import { useMode } from '../lib/mode.js'
import Sheet from './forms/Sheet.jsx'
import Icon from './Icon.jsx'

// BottomNav — V200 / V4-THEME-001 nav: Today·Garden·＋·DrG·More.
// V200 Slice 9 (2026-07-01): the two hand-rolled slide-up dialogs (Create FAB sheet +
// More menu) now adopt the shared Sheet primitive (a11y: role=dialog, aria-modal, focus
// trap+restore, Escape, backdrop-dismiss — Sheet owns all of it, so the local Escape
// effect is gone). More menu is grouped into labeled sections (Your garden / Rewards /
// Help & account) instead of one flat 10-item scan. Field/Desk mode gets a mirror row
// here (TopBar retired V4-APPBAR-003; this is now the PRIMARY mode toggle). Critters is by placement + a soft
// subtitle only — NO badge/count/alert (Reward UX V102, ambient). Glyphs are still emoji;
// the emoji->Icon SVG pass is the deferred Slice 9 follow-up commit.
const TABS = [
  { to: '/today',    label: 'Today',  iconName: 'nav.today' },
  { to: '/garden',   label: 'Garden', iconName: 'nav.garden' },
  { to: '/log',      label: 'Create', iconName: 'nav.plus', highlight: true },
  { to: '/findings', label: 'DrG',    iconName: 'nav.findings' },
]

// +LOG FAB -> create action sheet. Slice 9: trimmed to 3 first-class quick-hit actions.
// Log + Log many are the two rapid-capture verbs — Log many stays FIRST-CLASS (a direct
// tap, never nested under Log, per Dave 2026-07-01); Add a planting is the one daily
// create. New project + Add inventory dropped from the FAB (Projects de-emphasizing from
// first-class; inventory-add is reachable via More -> Inventory). Not a reward surface
// (user-initiated create menu), so the sheet pattern is appropriate under Reward UX V102.
// V4-SOWFAB-001: Sow from seed added as the 4th action, directly under Add a planting — the two
// are the same verb from different starting points (existing plant vs seed packet), and /sow was
// previously reachable only by URL. Fills the documented <=4 budget exactly; nothing displaced.
const CREATE_ACTIONS = [
  { to: '/log',          iconName: 'event.other',      label: 'Log an event',   sub: 'Watering, harvest, a note…' },
  { to: '/log/many',     iconName: 'action.logmany',   label: 'Log many',        sub: 'One event across many plants' },
  { to: '/garden?add=1', iconName: 'lifecycle.sprout', label: 'Add a planting', sub: 'A plant growing in a project' },
  { to: '/sow',          iconName: 'lifecycle.sprout', label: 'Sow from seed',  sub: 'Start something from your seed inventory' },
]

// Shared menu-row style. `border:'none'` first so buttons drop their default border, then
// `borderTop` as the row separator (later longhand wins over the shorthand).
const menuRowStyle = {
  display: 'flex', alignItems: 'center', gap: 16,
  width: '100%', padding: '14px 24px',
  border: 'none', borderTop: `1px solid ${P.border}`,
  background: 'none', textAlign: 'left',
  cursor: 'pointer', textDecoration: 'none',
  color: P.dark, fontSize: '1rem', fontWeight: 500,
  fontFamily: 'inherit', minHeight: 48,
}

function SectionLabel({ children }) {
  return (
    <div style={{
      padding: '14px 24px 4px', fontSize: '0.72rem', fontWeight: 700,
      letterSpacing: '0.04em', textTransform: 'uppercase', color: P.light,
    }}>
      {children}
    </div>
  )
}

export default function BottomNav() {
  const location = useLocation()
  const navigate = useNavigate()
  const { profile, signOut } = useAuth()
  const { getToken } = useApiFetch()
  // Field-mode swaps the +LOG center button for a mic -> /field. Desk-mode unchanged.
  // toggleMode powers the More-menu mode mirror row.
  const { isField, toggleMode } = useMode()
  const [showMore, setShowMore]             = useState(false)
  const [showCreate, setShowCreate]         = useState(false)
  const [confirmSignOut, setConfirmSignOut] = useState(false)

  function isActive(path) {
    return location.pathname === path || location.pathname.startsWith(path + '/')
  }

  function closeMore() {
    setShowMore(false)
    setConfirmSignOut(false)
  }

  function closeCreate() {
    setShowCreate(false)
  }

  async function handleSignOutConfirmed() {
    closeMore()
    await signOut()
    navigate('/', { replace: true })
  }

  return (
    <>
      {/* +LOG create action sheet (Sheet primitive) */}
      <Sheet open={showCreate} onClose={closeCreate} ariaLabel="Create new">
        <div style={{ padding: '6px 24px 8px', fontSize: '0.8rem', color: P.light }}>
          Add to your garden
        </div>
        {CREATE_ACTIONS.map(action => (
          <Link
            key={action.label}
            to={action.to}
            onClick={closeCreate}
            style={{ ...menuRowStyle, padding: '12px 24px' }}
          >
            <Icon name={action.iconName} size={24} decorative style={{ color: P.green }} />
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '1rem', fontWeight: 600 }}>{action.label}</span>
              <span style={{ fontSize: '0.78rem', color: P.light }}>{action.sub}</span>
            </span>
          </Link>
        ))}
      </Sheet>

      {/* More menu (Sheet primitive) */}
      <Sheet open={showMore} onClose={closeMore} ariaLabel="More navigation options">
        {/* Signed-in identity */}
        <div style={{ padding: '4px 24px 12px', fontSize: '0.8rem', color: P.light }}>
          {profile?.display_name || profile?.email || 'Signed in'}
        </div>

        {/* Field/Desk mode mirror — keeps the current mode visible + switchable here too
            (TopBar retired V4-APPBAR-003; this is the primary mode toggle now). Toggling does NOT close the sheet so the
            change is visible. Operational surface, not a reward surface. */}
        <button
          type="button"
          onClick={toggleMode}
          aria-label={`View mode: ${isField ? 'Field' : 'Desk'}. Activate to switch to ${isField ? 'Desk' : 'Field'} mode.`}
          style={{ ...menuRowStyle, justifyContent: 'space-between' }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Icon name={isField ? 'facet.type' : 'mode.desk'} size={22} decorative />
            View mode
          </span>
          <span style={{ fontSize: '0.85rem', fontWeight: 700, color: P.green }}>
            {isField ? 'Field' : 'Desk'}
          </span>
        </button>

        <SectionLabel>Your garden</SectionLabel>
        <Link to="/dashboard" onClick={closeMore} style={menuRowStyle}>
          <Icon name="nav.dashboard" size={22} decorative />Dashboard
        </Link>
        <Link to="/photos" onClick={closeMore} style={menuRowStyle}>
          <Icon name="media.camera" size={22} decorative />Photos
        </Link>
        <Link to="/inventory" onClick={closeMore} style={menuRowStyle}>
          <Icon name="nav.inventory" size={22} decorative />Inventory
        </Link>
        <Link to="/achievements" onClick={closeMore} style={menuRowStyle}>
          <span aria-hidden="true" style={{ fontSize: '1.4rem' }}>🏆</span>Achievements
        </Link>
        {/* Catch-up badge — gated behind CATCH_UP_EDITOR_SHIPPED (currently off). */}
        {CATCH_UP_EDITOR_SHIPPED && (
          <div data-testid="catch-up-nav-item" onClick={closeMore} style={{ padding: '12px 24px 4px' }}>
            <CatchUpBadge />
          </div>
        )}

        <SectionLabel>Rewards</SectionLabel>
        {/* Critters — ambient reward surface (Reward UX V102): distinguished by placement +
            subtitle, NEVER by a badge/count/alert. */}
        <Link
          to="/collection"
          onClick={closeMore}
          style={{ ...menuRowStyle, alignItems: 'flex-start' }}
        >
          <Icon name="nav.critters" size={22} decorative style={{ lineHeight: 1.2 }} />
          <span style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: '1rem', fontWeight: 500 }}>Critters</span>
            <span style={{ fontSize: '0.78rem', color: P.light }}>Who&apos;s been visiting</span>
          </span>
        </Link>

        <SectionLabel>Help &amp; account</SectionLabel>
        <Link to="/helper" onClick={closeMore} style={menuRowStyle}>
          <Icon name="nav.helper" size={22} decorative />Garden Helper
        </Link>
        <Link to="/settings" onClick={closeMore} style={menuRowStyle}>
          <Icon name="action.settings" size={22} decorative />Settings
        </Link>
        <Link to="/about" onClick={closeMore} style={menuRowStyle}>
          <Icon name="action.info" size={22} decorative />About
        </Link>
        <Link to="/releases" onClick={closeMore} style={menuRowStyle}>
          <Icon name="nav.notes" size={22} decorative />Release Notes<WhatsNewDot variant="inline" />
        </Link>

        {/* Sign Out — inline 2-step confirm (BottomNav-owned; Sheet stays a dumb container).
            A session-ending action must not be an impulsive mis-tap target. */}
        {!confirmSignOut ? (
          <button onClick={() => setConfirmSignOut(true)} style={menuRowStyle}>
            <Icon name="nav.signout" size={22} decorative />Sign out
          </button>
        ) : (
          <div style={{
            padding: '14px 24px', display: 'flex', flexDirection: 'column', gap: 10,
            borderTop: `1px solid ${P.border}`,
          }}>
            <p style={{ margin: 0, fontSize: '0.92rem', color: P.dark, fontWeight: 500 }}>
              Sign out of your account?
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setConfirmSignOut(false)}
                style={{
                  flex: 1, minHeight: 44,
                  border: `1px solid ${P.border}`, borderRadius: 8,
                  background: P.cream, color: P.dark,
                  fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSignOutConfirmed}
                style={{
                  flex: 1, minHeight: 44,
                  border: 'none', borderRadius: 8,
                  background: P.terra, color: P.white,
                  fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Yes, sign out
              </button>
            </div>
          </div>
        )}
      </Sheet>

      <nav aria-label="Main navigation" style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        height: 'var(--bottom-nav-height)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        backgroundColor: P.white,
        borderTop: `1px solid ${P.border}`,
        display: 'flex', alignItems: 'stretch',
        zIndex: 100,
      }}>
        {TABS.map(tab => {
          const active = isActive(tab.to)
          if (tab.highlight) {
            // Field mode: center button becomes a mic -> /field (no create sheet).
            // Desk mode (default): +LOG FAB opens the create action sheet.
            if (isField) return (
              <Link key={tab.to} to="/field"
                onClick={() => { closeMore(); closeCreate() }}
                data-testid="bottomnav-field-mic"
                aria-label="Go to field capture"
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', padding: 0, minHeight: 44 }}>
                <span style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 44, height: 44, backgroundColor: P.terra, borderRadius: '50%',
                  color: '#fff', fontSize: '1.3rem', fontWeight: 700,
                  boxShadow: '0 2px 8px rgba(183,83,42,0.35)',
                }} aria-hidden="true"><Icon name="media.mic" size={22} decorative style={{ color: '#fff' }} /></span>
              </Link>
            )
            return (
            <button key={tab.to} type="button"
              onClick={() => { closeMore(); setShowCreate(s => !s) }}
              aria-haspopup="true" aria-expanded={showCreate} aria-label="Create"
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', cursor: 'pointer', padding: 0, minHeight: 44 }}>
              <span style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 44, height: 44, backgroundColor: P.green, borderRadius: '50%',
                color: '#fff', fontSize: '1.5rem', fontWeight: 700,
                boxShadow: '0 2px 8px rgba(45,106,79,0.35)',
              }}><Icon name="nav.plus" size={24} decorative style={{ color: '#fff' }} /></span>
            </button>
          )}
          return (
            <Link key={tab.to} to={tab.to} aria-current={active ? 'page' : undefined}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', gap: 2, color: active ? P.green : P.light, minHeight: 44, position: 'relative' }}>
              <Icon name={tab.iconName} size={22} decorative />
              <span style={{ fontSize: '0.62rem', fontWeight: active ? 700 : 400 }}>{tab.label}</span>
            </Link>
          )
        })}

        <button onClick={() => { closeCreate(); setShowMore(s => !s) }}
          aria-expanded={showMore} aria-label="More navigation options"
          style={{
            flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 2, background: 'none', border: 'none', cursor: 'pointer',
            color: showMore ? P.green : P.light, padding: 0, minHeight: 44, position: 'relative',
          }}>
          <Icon name="nav.more" size={22} decorative />
          <span style={{ fontSize: '0.62rem', fontWeight: showMore ? 700 : 400 }}>More</span>
          {/* Critter "new visitor" dot lives on More now that Critters is in the menu. */}
          <BottomNavDot getToken={getToken} />
        </button>
      </nav>
    </>
  )
}

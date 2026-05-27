import React, { useState, useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { P } from '../lib/constants.js'
import CatchUpBadge from './CatchUpBadge.jsx'
import { CATCH_UP_EDITOR_SHIPPED } from '../lib/featureFlags.js'

// BottomNav — NAV-IA-1 layout (V1.2a-3 Increment C / PR-C1, 2026-05-18)
// Tabs: Projects · Plants · (centered LOG+) · Inventory · (… More menu)
// Dashboard dropped — reachable via the "Gardens at Home" TopBar banner.
// More menu (NOW scope): Sign Out only, with inline confirmation step.
//   - Sign Out moved here from TopBar (top-nav More button replaced with Favorites icon).
//   - Confirmation step is a hard gate per reconciliation plan §2 — session-ending
//     action must not be an impulsive-mistap target.
// Overflow is a V3 IA-revision concern, explicitly out of NAV-IA-1 scope.

// Increment 1 (post-V2 UX overhaul): Projects + Plants unified into one "Garden" tab
// (nested accordion tree). Nav = Garden · +LOG · Inventory · More; the freed 5th slot
// is reserved for Tasks/Care (Increment 3+). /projects + /plants stay routable.
const TABS = [
  { to: '/garden',    label: 'Garden',    icon: '🌳' },
  { to: '/log',       label: '+Log',      icon: '+',  highlight: true },
  { to: '/inventory', label: 'Inventory', icon: '📦' },
]

// +LOG FAB → create action sheet (Increment 1, post-V2 UX overhaul).
// Tapping the center +LOG opens a <=4-choice sheet so every create flow is reachable
// without first navigating to a tab. This is a user-initiated operational/navigation
// affordance — NOT a reward surface (no celebration / recognition / progress signal),
// so the action-sheet pattern is appropriate (Reward UX V100 out-of-scope channels bind
// reward surfaces, not user-triggered create menus).
// Routes: Log -> /log (EventNew); Plant -> /plants?add=1 (Plants add-form auto-open);
//         Project -> /projects/new (ProjectNew); Inventory -> /inventory/add (InventoryAdd).
// Spec: postv2-ux-overhaul-phase2-build-roadmap-V001 §4 Increment 1 + garden-tab-design-V001 §3.4.
const CREATE_ACTIONS = [
  { to: '/log',           icon: '📝', label: 'Log an event',   sub: 'Watering, harvest, a note…' },
  { to: '/plants?add=1',  icon: '🌱', label: 'Add a planting', sub: 'A plant growing in a project' },
  { to: '/projects/new',  icon: '🪴', label: 'New project',     sub: 'A bed, crop, or grow' },
  { to: '/inventory/add', icon: '📦', label: 'Add inventory',   sub: 'Seeds, soil, supplies…' },
]

export default function BottomNav() {
  const location = useLocation()
  const navigate = useNavigate()
  const { profile, signOut } = useAuth()
  const [showMore, setShowMore]               = useState(false)
  const [showCreate, setShowCreate]           = useState(false)
  const [confirmSignOut, setConfirmSignOut]   = useState(false)

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

  // Escape closes whichever sheet is open (dialog-dismissal a11y; mirrors the
  // backdrop tap-to-close already provided by the overlay).
  useEffect(() => {
    if (!showMore && !showCreate) return
    function onKey(e) {
      if (e.key === 'Escape') { closeMore(); closeCreate() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showMore, showCreate])

  async function handleSignOutConfirmed() {
    closeMore()
    await signOut()
    navigate('/', { replace: true })
  }

  return (
    <>
      {/* +LOG create action sheet — backdrop + slide-up dialog (mirrors More menu) */}
      {showCreate && (
        <div onClick={closeCreate}
          style={{ position: 'fixed', inset: 0, zIndex: 90, backgroundColor: 'rgba(0,0,0,0.3)' }}
        />
      )}

      {showCreate && (
        <div role="dialog" aria-label="Create new" style={{
          position: 'fixed',
          bottom: 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom))',
          left: 0, right: 0,
          backgroundColor: P.white,
          borderRadius: '16px 16px 0 0',
          boxShadow: '0 -4px 20px rgba(0,0,0,0.14)',
          zIndex: 100,
          paddingTop: 8, paddingBottom: 12,
        }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: P.border, margin: '0 auto 8px' }} />
          <div style={{ padding: '6px 24px 8px', fontSize: '0.8rem', color: P.light }}>
            Add to your garden
          </div>
          {CREATE_ACTIONS.map(action => (
            <Link
              key={action.label}
              to={action.to}
              onClick={closeCreate}
              style={{
                display: 'flex', alignItems: 'center', gap: 16,
                width: '100%',
                padding: '12px 24px',
                borderTop: `1px solid ${P.border}`,
                background: 'none', textAlign: 'left',
                cursor: 'pointer', textDecoration: 'none',
                color: P.dark, fontFamily: 'inherit',
                minHeight: 48,
              }}
            >
              <span aria-hidden="true" style={{ fontSize: '1.5rem' }}>{action.icon}</span>
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: '1rem', fontWeight: 600 }}>{action.label}</span>
                <span style={{ fontSize: '0.78rem', color: P.light }}>{action.sub}</span>
              </span>
            </Link>
          ))}
        </div>
      )}

      {showMore && (
        <div onClick={closeMore}
          style={{ position: 'fixed', inset: 0, zIndex: 90, backgroundColor: 'rgba(0,0,0,0.3)' }}
        />
      )}

      {showMore && (
        <div role="dialog" aria-label="More navigation options" style={{
          position: 'fixed',
          bottom: 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom))',
          left: 0, right: 0,
          backgroundColor: P.white,
          borderRadius: '16px 16px 0 0',
          boxShadow: '0 -4px 20px rgba(0,0,0,0.14)',
          zIndex: 100,
          paddingTop: 8, paddingBottom: 12,
        }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: P.border, margin: '0 auto 8px' }} />

          {/* Signed-in identity row */}
          <div style={{
            padding: '10px 24px 14px',
            borderBottom: `1px solid ${P.border}`,
            fontSize: '0.8rem',
            color: P.light,
          }}>
            {profile?.display_name || profile?.email || 'Signed in'}
          </div>

          {/* V1.2a-4 S1: Catch-up badge surfaces plants with missing lifecycle dates.
              Render owned here, not on Dashboard (V102 §5.1 #8 + UX item 11).
              HIDDEN 2.0.1 (gifted-busy-thompson): badge linked to /plants/catch-up, whose
              S1.1 editor was never built — it shipped into V2 as a "coming soon" dead-end.
              Gated behind CATCH_UP_EDITOR_SHIPPED; flip true when the S1.1 editor lands
              (planned 2.1). See v2-increment-audit-2.0.1-to-2.1-V001. */}
          {CATCH_UP_EDITOR_SHIPPED && (
            <div data-testid="catch-up-nav-item" onClick={closeMore} style={{ padding: '12px 24px 4px' }}>
              <CatchUpBadge />
            </div>
          )}

          {/* Plants — restored to More menu (NAV-REGRESSION fix / BUG-13, 2026-05-24).
              /plants route + Plants.jsx remain routable (see TABS comment) but the nav
              entry was dropped by the NAV-IA-1 rework (PR-C1, 2026-05-18) — same regression
              class as Photos & Achievements below. Interim list-level restore; per-plant
              detail (/plants/:id + PlantDetail.jsx) is the full V3-NAV-001 deliverable. */}
          <Link
            to="/plants"
            onClick={closeMore}
            style={{
              display: 'flex', alignItems: 'center', gap: 16,
              width: '100%',
              padding: '14px 24px',
              borderTop: `1px solid ${P.border}`,
              background: 'none', textAlign: 'left',
              cursor: 'pointer', textDecoration: 'none',
              color: P.dark, fontSize: '1rem', fontWeight: 500,
              fontFamily: 'inherit',
              minHeight: 48,
            }}
          >
            <span aria-hidden="true" style={{ fontSize: '1.4rem' }}>🌱</span>
            Plants
          </Link>

          {/* Photos — restored to More menu (NAV-REGRESSION fix, 2026-05-23).
              /photos route + PhotoLibrary.jsx shipped V2-PHOTO-F1; nav entry was
              dropped by the NAV-IA-1 rework (PR-C1, 2026-05-18) — same regression
              class as Achievements. Restores access to the standalone photo library. */}
          <Link
            to="/photos"
            onClick={closeMore}
            style={{
              display: 'flex', alignItems: 'center', gap: 16,
              width: '100%',
              padding: '14px 24px',
              borderTop: `1px solid ${P.border}`,
              background: 'none', textAlign: 'left',
              cursor: 'pointer', textDecoration: 'none',
              color: P.dark, fontSize: '1rem', fontWeight: 500,
              fontFamily: 'inherit',
              minHeight: 48,
            }}
          >
            <span aria-hidden="true" style={{ fontSize: '1.4rem' }}>📷</span>
            Photos
          </Link>

          {/* Achievements — restored to More menu (NAV-REGRESSION fix, 2026-05-22).
              Route + page shipped V1.2a-1 S4; nav entry was dropped by the NAV-IA-1
              rework (PR-C1, 2026-05-18). Restores access per the V1.2 NAV-REGRESSION
              blocker (sprint-tracker §V1.2 Blockers). Full dedicated-tab placement
              remains a V2 consideration. */}
          <Link
            to="/achievements"
            onClick={closeMore}
            style={{
              display: 'flex', alignItems: 'center', gap: 16,
              width: '100%',
              padding: '14px 24px',
              borderTop: `1px solid ${P.border}`,
              background: 'none', textAlign: 'left',
              cursor: 'pointer', textDecoration: 'none',
              color: P.dark, fontSize: '1rem', fontWeight: 500,
              fontFamily: 'inherit',
              minHeight: 48,
            }}
          >
            <span aria-hidden="true" style={{ fontSize: '1.4rem' }}>🏆</span>
            Achievements
          </Link>

          {/* Critter Collection — preview dex (Phase 1). Reward surface; ambient nav entry.
              /collection route + Collection.jsx. Spec: critter-collection-page-spec-V001. */}
          <Link
            to="/collection"
            onClick={closeMore}
            style={{
              display: 'flex', alignItems: 'center', gap: 16,
              width: '100%',
              padding: '14px 24px',
              borderTop: `1px solid ${P.border}`,
              background: 'none', textAlign: 'left',
              cursor: 'pointer', textDecoration: 'none',
              color: P.dark, fontSize: '1rem', fontWeight: 500,
              fontFamily: 'inherit',
              minHeight: 48,
            }}
          >
            <span aria-hidden="true" style={{ fontSize: '1.4rem' }}>🦋</span>
            Critters
          </Link>

          {/* Sign Out — inline confirmation */}
          {!confirmSignOut ? (
            <button
              onClick={() => setConfirmSignOut(true)}
              style={{
                display: 'flex', alignItems: 'center', gap: 16,
                width: '100%',
                padding: '14px 24px',
                background: 'none', border: 'none', textAlign: 'left',
                cursor: 'pointer',
                color: P.dark, fontSize: '1rem', fontWeight: 500,
                fontFamily: 'inherit',
                minHeight: 48,
              }}
            >
              <span aria-hidden="true" style={{ fontSize: '1.4rem' }}>↪</span>
              Sign out
            </button>
          ) : (
            <div style={{ padding: '14px 24px', display: 'flex', flexDirection: 'column', gap: 10 }}>
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
        </div>
      )}

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
          if (tab.highlight) return (
            <button key={tab.to} type="button"
              onClick={() => { closeMore(); setShowCreate(s => !s) }}
              aria-haspopup="true" aria-expanded={showCreate} aria-label="Create"
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', cursor: 'pointer', padding: 0, minHeight: 44 }}>
              <span style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 44, height: 44, backgroundColor: P.green, borderRadius: '50%',
                color: '#fff', fontSize: '1.5rem', fontWeight: 700,
                boxShadow: '0 2px 8px rgba(45,106,79,0.35)',
              }}>+</span>
            </button>
          )
          return (
            <Link key={tab.to} to={tab.to}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', gap: 2, color: active ? P.green : P.light, minHeight: 44 }}>
              <span style={{ fontSize: '1.25rem', lineHeight: 1 }}>{tab.icon}</span>
              <span style={{ fontSize: '0.62rem', fontWeight: active ? 700 : 400 }}>{tab.label}</span>
            </Link>
          )
        })}

        <button onClick={() => { closeCreate(); setShowMore(s => !s) }}
          aria-expanded={showMore} aria-label="More navigation options"
          style={{
            flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 2, background: 'none', border: 'none', cursor: 'pointer',
            color: showMore ? P.green : P.light, padding: 0, minHeight: 44,
          }}>
          <span style={{ fontSize: '1.25rem', lineHeight: 1, letterSpacing: '-1px' }}>•••</span>
          <span style={{ fontSize: '0.62rem', fontWeight: showMore ? 700 : 400 }}>More</span>
        </button>
      </nav>
    </>
  )
}

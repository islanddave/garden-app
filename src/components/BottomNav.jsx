import React, { useState, useLayoutEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useOverlayLocation, OverlayLink } from '../context/OverlayContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import WhatsNewDot from './WhatsNewDot.jsx'
import { P, BOTTOM_NAV_HEIGHT_PX } from '../lib/constants.js'
import CatchUpBadge from './CatchUpBadge.jsx'
import { CATCH_UP_EDITOR_SHIPPED, PROJECTS_HIDDEN, SPACE_PHOTOS_ENABLED } from '../lib/featureFlags.js'
import { useApiFetch } from '../lib/api.js'
import BottomNavDot from './BottomNavDot.jsx'
import { useMode } from '../lib/mode.js'
import { useKeyboardChromeSuppressed } from '../lib/keyboardChrome.js'
import Sheet from './forms/Sheet.jsx'
import Icon from './Icon.jsx'

// BottomNav — V200 / V4-THEME-001 nav: Today·Garden·＋·Harvests·More (V4-NAVHARVEST-001, 2026-08-10;
// was Today·Garden·＋·DrG·More — DrG demoted into More, see TABS below).
// V200 Slice 9 (2026-07-01): the two hand-rolled slide-up dialogs (Create FAB sheet +
// More menu) now adopt the shared Sheet primitive (a11y: role=dialog, aria-modal, focus
// trap+restore, Escape, backdrop-dismiss — Sheet owns all of it, so the local Escape
// effect is gone). More menu is grouped into labeled sections (Your garden / Rewards /
// Help & account) instead of one flat 10-item scan. Field/Desk mode gets a mirror row
// here (TopBar retired V4-APPBAR-003; this is now the PRIMARY mode toggle). Critters is by placement + a soft
// subtitle only — NO badge/count/alert (Reward UX V102, ambient). Glyphs are still emoji;
// the emoji->Icon SVG pass is the deferred Slice 9 follow-up commit.
// V4-NAVHARVEST-001 (design: uiux-homogenization-master-plan-V100-20260723 §1.3, CONFIRMED
// 2026-07-23, unbuilt until now). DrG/Findings demotes OUT of the tab bar into More — its own
// code calls the surface "sparse" and it re-explains Today — and Harvests takes the slot. The
// design deliberately kept these two moves SEPARABLE (demote now, promote later, gated on
// /harvests existing); both are taken together here because /harvests is already live in prod
// and was only ever reachable buried in the More menu.
// `glyph` instead of `iconName`: mirrors the Harvests/Put-Up/Zones More rows, which use raw
// emoji precisely to avoid adding an iconAnchors entry + an icon-completeness harness case for
// a destination that has no drawn SVG. Tabs render one or the other, never both.
const TABS = [
  { to: '/today',    label: 'Today',    iconName: 'nav.today' },
  { to: '/garden',   label: 'Garden',   iconName: 'nav.garden' },
  { to: '/log',      label: 'Create',   iconName: 'nav.plus', highlight: true },
  { to: '/harvests', label: 'Harvests', glyph: '🧺' },
]

// +LOG FAB -> create action sheet. Slice 9: trimmed to 3 first-class quick-hit actions.
// Log + Log many are the two rapid-capture verbs — Log many stays FIRST-CLASS (a direct
// tap, never nested under Log, per Dave 2026-07-01); Add a planting is the one daily
// create. New project + Add inventory dropped from the FAB (Projects de-emphasizing from
// first-class; inventory-add is reachable via More -> Inventory). Not a reward surface
// (user-initiated create menu), so the sheet pattern is appropriate under Reward UX V102.
// V4-SOWFAB-001: Sow from seed added as the 4th action, directly under Add a planting — the two
// are the same verb from different starting points (existing plant vs seed packet), and /sow was
// previously reachable only by URL.
//
// V4-HARVFAB-001 (design harvest-logging-ux-design-V100-20260812 §1c, BD-002) — THE BUDGET IS NOW
// 5, AND 5 IS A HARD CAP. Harvest takes the FIRST slot: it is the highest-frequency event in the
// app by an order of magnitude and cost SEVEN taps to reach through "Log an event". Read this
// before touching the list:
//   - Any SIXTH action requires DISPLACEMENT, not expansion. The sheet is a glance surface; the
//     budget existed before this change and survives it.
//   - Slot 1 encodes ANNUAL frequency, not today's season. A winter session looking at a quiet
//     harvest month must not "fix" the ordering — it will be wrong again by June.
//   - Displacement was considered and rejected here: "Log many" is Dave-protected first-class
//     (2026-07-01 directive) and Add a planting / Sow from seed have active seasonal
//     constituencies.
//   - Expect a few days of muscle-memory mistaps from "Log an event" regulars. Recovery is one
//     in-form tap — the type picker renders below the harvest panel — so there is no back-out and
//     no lost input.
// "Log an event"'s sub-copy drops "harvest" in the same change: two harvest-scented rows in one
// sheet is a worse sheet than either row alone.
const CREATE_ACTIONS = [
  { to: '/log?event_type=harvest', glyph: '🍅',                label: 'Log harvest',    sub: 'Straight to the harvest form' },
  { to: '/log',          iconName: 'event.other',      label: 'Log an event',   sub: 'Watering, a note…' },
  { to: '/log/many',     iconName: 'action.logmany',   label: 'Log many',        sub: 'One event across many plants' },
  // V4-PROJHIDE-001: project-neutral sub-label when "project" is not a user-facing concept. Flag OFF
  // keeps the original copy — module-const evaluated once at load, so behavior is byte-identical.
  { to: '/garden?add=1', iconName: 'lifecycle.sprout', label: 'Add a planting', sub: PROJECTS_HIDDEN ? "Something you're growing" : 'A plant growing in a project' },
  { to: '/sow',          iconName: 'lifecycle.sprout', label: 'Sow from seed',  sub: 'Start something from your seed inventory' },
]

// The create-menu targets that open as overlays (§6). Others navigate as pages.
// MATCHED AGAINST `action.to` BY EXACT STRING — not by pathname. A query-string route therefore
// needs its FULL string listed here or it silently falls through to a full-page navigation, which
// is precisely the bug V4-HARVFAB-001 would have shipped. Exact-string is deliberate over
// pathname-matching: stripping the query would also opt in every future `/log?…` route, and
// `/garden?add=1` stays a page on purpose (Slice 3). One consumer, below.
const OVERLAYABLE_CREATE = new Set(['/log', '/log/many', '/log?event_type=harvest'])

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

// The nav's real height, and the single source of truth for --bottom-nav-height.
//
// The VARIABLE IS OWNED HERE rather than hardcoded at :root, because the nav is conditional —
// App.jsx renders it only when signed in. A constant 56px at :root meant every bottom-anchored
// surface reserved space for a nav that wasn't there: on the sign-in and public-share screens a
// toast, and the UpdateBanner (which renders regardless of auth, by design — BUG-STALECLIENT-001),
// floated ~56px above the bottom edge over nothing.
//
// Owning it here keeps the two in sync automatically: if the nav's render condition ever changes,
// the variable follows, whereas driving it from App.jsx's `user` check would silently desync.
// useLayoutEffect (not useEffect) so the value is committed BEFORE paint — otherwise the first
// frame lays content out against 0px and visibly shifts.
// The NUMBER now lives in lib/constants.js (so pages can clear the nav without importing it);
// re-exported here because this component owns the VARIABLE and is where readers look for it.
export { BOTTOM_NAV_HEIGHT_PX }

export default function BottomNav() {
  const location = useOverlayLocation()
  // V4-KBCHROME-001 — ONE predicate drives BOTH the paint (visibility on the <nav> below) and
  // the inset var, in the SAME commit: the style prop lands in React's DOM mutation pass and
  // this useLayoutEffect runs synchronously after it, both before the next paint — so the var
  // and the pixels can never disagree for a frame, in either direction (suppress AND restore).
  // Detector rationale + jsdom inertness (always false there): lib/keyboardChrome.js.
  const kbSuppressed = useKeyboardChromeSuppressed()
  useLayoutEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--bottom-nav-height', kbSuppressed ? '0px' : `${BOTTOM_NAV_HEIGHT_PX}px`)
    return () => { root.style.setProperty('--bottom-nav-height', '0px') }
  }, [kbSuppressed])
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
        {CREATE_ACTIONS.map(action => {
          // V4-OVERLAY-001 Slice 2: /log + /log/many open as flyovers over the current page; /sow and
          // /garden?add=1 stay plain page navigations (§6 — /sow is a page, add-planting is Slice 3).
          const RowLink = OVERLAYABLE_CREATE.has(action.to) ? OverlayLink : Link
          return (
            <RowLink
              key={action.label}
              to={action.to}
              onClick={closeCreate}
              // V4-HARVFAB-001: the budget guard counts THESE, not links filtered by an href
              // allow-list — an allow-list passes vacuously against exactly the change it is
              // supposed to catch (a new action). See BottomNav.createBudget.test.jsx.
              data-testid="create-action"
              style={{ ...menuRowStyle, padding: '12px 24px' }}
            >
              {/* V4-HARVFAB-001: same glyph-or-iconName contract the TABS rows use — one or the
                  other, never both. No `event.harvest` icon anchor exists, and minting one would
                  add an iconAnchors entry plus an icon-completeness harness case for a single row.
                  🍅 is deliberately NOT the /harvests tab's 🧺: create action vs browse surface. */}
              {action.glyph
                ? <span aria-hidden="true" style={{ fontSize: '1.35rem', lineHeight: 1, width: 24, textAlign: 'center' }}>{action.glyph}</span>
                : <Icon name={action.iconName} size={24} decorative style={{ color: P.green }} />}
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: '1rem', fontWeight: 600 }}>{action.label}</span>
                <span style={{ fontSize: '0.78rem', color: P.light }}>{action.sub}</span>
              </span>
            </RowLink>
          )
        })}
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
        {/* V4-NAVHARVEST-001 — DrG demoted here from the tab bar. DEMOTED, NOT REMOVED: /findings
            keeps its route, its page and its drawn nav.findings icon, and every deep link into it
            still resolves. It sits beside Dashboard because both are read-only overview surfaces.
            BottomNavDot (the critter poll) is unaffected — it hangs off the nav shell, not this tab. */}
        <Link to="/findings" onClick={closeMore} style={menuRowStyle}>
          <Icon name="nav.findings" size={22} decorative />DrG
        </Link>
        <Link to="/photos" onClick={closeMore} style={menuRowStyle}>
          <Icon name="media.camera" size={22} decorative />Photos
        </Link>
        {/* V4-SPACEPHOTO-001 Lane C — a NEW row, above the zones row, because the two are different
            tiers and neither can stand in for the other: "Space" (singular) is the property itself
            (the one `spaces` row), while /locations is the tree of six level-0 ZONES beneath it
            (Deck/Drive/House/Pasture/Stable/Yard, measured live). Re-pointing the existing row would
            have silently stolen /locations' ONLY nav entry — the exact gap V4-PHOTOLOCFIND-001 added
            it to close (only 5 of 913 photos carried a location). Flag-gated, so flag-off renders the
            shipped single row unchanged. Emoji glyph mirrors Harvests/Put-Up (a new row would
            otherwise need an iconRegistry entry + the icon-completeness harness). */}
        {SPACE_PHOTOS_ENABLED && (
          <Link to="/space" onClick={closeMore} style={menuRowStyle}>
            <span aria-hidden="true" style={{ fontSize: '1.4rem' }}>🏡</span>Space
          </Link>
        )}
        {/* V4-PHOTOLOCFIND-001 — /locations previously had ZERO nav entries (reachable only
            from Search/Favorites/ProjectNew/ZonePicker), which is half of why only 5 of 913 photos
            carried a location. Emoji glyph mirrors Harvests/Put-Up (avoids the icon-completeness
            harness for a new row).
            V4-SPACECLIENTGAP-001 (Dave 2026-08-02): the label is now UNCONDITIONALLY "Zones", not
            flag-conditional. Two rows both reading "Space(s)" pointing at different tiers is the
            §6.8 four-noun drift made worse, and the level-0 rows this page is rooted in ARE zones
            regardless of whether the Space surface is switched on. Naming is a product decision,
            orthogonal to the feature gate: leaving it conditional would mean a rollback silently
            RENAMES a nav row under the user, which is worse than a stable, correct name. Label
            change only; the route and the page are untouched. */}
        <Link to="/locations" onClick={closeMore} style={menuRowStyle}>
          <span aria-hidden="true" style={{ fontSize: '1.4rem' }}>📍</span>Zones
        </Link>
        <Link to="/inventory" onClick={closeMore} style={menuRowStyle}>
          <Icon name="nav.inventory" size={22} decorative />Inventory
        </Link>
        {/* V4-NAVHARVEST-001 — the Harvests row that lived here was PROMOTED to the tab bar, not
            duplicated: two doors to one destination is the redundant door-pair the IA work exists to
            merge. Put-Up stays here and still reads as adjacent to Harvests (what you kept, next to
            where what-you-got now lives). */}
        {/* V4-HARVESTCENTER-001 — Put-Up mounts under "more" (design V101 §6 dec.2 → route under More).
            OverlayLink so it opens as a flyover over the current page when OVERLAY_ROUTES_ENABLED (flag
            off: a plain <Link>, full-page — byte-identical). Emoji glyph mirrors the Achievements row
            (avoids the icon-completeness harness for a brand-new destination). */}
        <OverlayLink to="/put-up" onClick={closeMore} style={menuRowStyle}>
          <span aria-hidden="true" style={{ fontSize: '1.4rem' }}>🫙</span>Put-Up
        </OverlayLink>
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
        height: `${BOTTOM_NAV_HEIGHT_PX}px`,
        paddingBottom: 'env(safe-area-inset-bottom)',
        backgroundColor: P.white,
        borderTop: `1px solid ${P.border}`,
        display: 'flex', alignItems: 'stretch',
        zIndex: 100,
        // V4-KBCHROME-001: hidden (not unmounted) while the soft keyboard is up — under
        // interactive-widget=resizes-content the nav otherwise rides the shrunken viewport up
        // to sit on the keyboard. visibility also removes it from hit-testing + the a11y tree.
        // Chrome, not a reward surface: plain visibility, no transition (Reward UX V102).
        visibility: kbSuppressed ? 'hidden' : 'visible',
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
              {tab.glyph
                ? <span aria-hidden="true" style={{ fontSize: '1.25rem', lineHeight: 1 }}>{tab.glyph}</span>
                : <Icon name={tab.iconName} size={22} decorative />}
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

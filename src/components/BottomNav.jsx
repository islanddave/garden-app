import React, { useState, useLayoutEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useOverlayLocation, OverlayLink, useOverlayNavigate } from '../context/OverlayContext.jsx'
import { readMarker } from '../lib/backNav.js'
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

// BottomNav — V200 / V4-THEME-001 nav: Today·Garden·＋·Harvests·Put-Up·More (V4-PUTUPENGINE-001,
// 2026-08-21; was Today·Garden·＋·Harvests·More per V4-NAVHARVEST-001, 2026-08-10, which itself
// replaced Today·Garden·＋·DrG·More — DrG demoted into More, see TABS below).
// V200 Slice 9 (2026-07-01): the two hand-rolled slide-up dialogs (Create FAB sheet +
// More menu) now adopt the shared Sheet primitive (a11y: role=dialog, aria-modal, focus
// trap+restore, Escape, backdrop-dismiss — Sheet owns all of it, so the local Escape
// effect is gone). More menu is grouped into labeled sections (Your garden / Rewards /
// Help & account) instead of one flat 10-item scan. Field/Desk mode gets a mirror row
// here (TopBar retired V4-APPBAR-003; this is now the PRIMARY mode toggle). Critters is by placement + a soft
// subtitle only — NO badge/count/alert (Reward UX V102, ambient).
// V4-ICON-001 (2026-08-26): the deferred Slice 9 follow-up landed — the last five emoji here
// (Harvests, Put-Up, Space, Zones, Achievements) are registry <Icon>s, so EVERY tab and every
// More row now draws from one SVG roster. Nothing in this file renders a pictographic character.
// V4-NAVHARVEST-001 (design: uiux-homogenization-master-plan-V100-20260723 §1.3, CONFIRMED
// 2026-07-23, unbuilt until now). DrG/Findings demotes OUT of the tab bar into More — its own
// code calls the surface "sparse" and it re-explains Today — and Harvests takes the slot. The
// design deliberately kept these two moves SEPARABLE (demote now, promote later, gated on
// /harvests existing); both are taken together here because /harvests is already live in prod
// and was only ever reachable buried in the More menu.
// These two tabs carried a raw `glyph` until V4-ICON-001 drew nav.harvests / nav.putup — the
// reason for the exception (no drawn SVG for the destination) is gone, so every TABS row now
// carries `iconName` and the glyph-or-iconName fork is retired with it.
// V4-PUTUPENGINE-001 slice 1 (Dave ruling 2026-08-20: "I'm just gonna go to a put up tab and start
// there the same way I'm going to the harvest tab … that is its own process that deserves its own
// landing page"). Put-Up PROMOTES out of the More sheet into the tab bar and the bar grows to SIX
// slots — the first time it has. That is an ADD WITHOUT A DISPLACEMENT, against the V4-NAVHARVEST-001
// precedent (DrG was demoted so Harvests could rise), because nothing here is displaceable FOR
// put-up: Today/Garden/＋ are the daily spine, and Harvests is the surface Dave names in the same
// breath as one he still goes to — demoting it to seat its own divorced peer would undo the ruling
// rather than serve it. The "4 IS THE CAP" note at CREATE_ACTIONS governs the FAB sheet and has
// never bound TABS; the only cap the tab bar ever had was the slot count pinned in BottomNav.test.
// Plain <Link>, NOT OverlayLink — the More row was `overlay` (a flyover over whatever page you were
// already on), and a flyover is precisely what a landing page is not. /put-up keeps
// `overlayable: true` in App.jsx, so the three PREFILL doors that need the flyover keep it
// (EventNew PreserveOffer, PutUpFromPlanting, PutUpUseSoonBand). PutUp already defaults a BARE open
// to its 'stores' view, so the tab lands on "what have I got", not on an empty form.
const TABS = [
  { to: '/today',    label: 'Today',    iconName: 'nav.today' },
  { to: '/garden',   label: 'Garden',   iconName: 'nav.garden' },
  { to: '/log',      label: 'Create',   iconName: 'nav.plus', highlight: true },
  { to: '/harvests', label: 'Harvests', iconName: 'nav.harvests' },
  { to: '/put-up',   label: 'Put-Up',   iconName: 'nav.putup' },
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
// V4-HARVFABREMOVE-001 (BD-028) — THE BUDGET IS BACK TO 4, AND 4 IS THE CAP. The "Log harvest"
// row is GONE: V4-TOPCHROMEACTIONS-001 put a Harvest action in TopChrome, which renders on every
// content surface, so the sheet row became the second way to reach one form (Dave ruled it
// redundant once the header action exists). This REVERSES V4-HARVFAB-001 (shipped prod a4c8c2b
// off a 9-seat crucible) — and reverses only its PLACEMENT, not its finding: harvest is still the
// highest-frequency event in the app by an order of magnitude, which is exactly why it earned
// permanent chrome instead of a slot in a menu you have to open first. Taps went 7 -> 2 (FAB, row)
// -> 1 (header). What survives from that crucible and still binds:
//   - Any FIFTH action requires DISPLACEMENT, not expansion. The sheet is a glance surface.
//   - Ordering encodes ANNUAL frequency, not today's season.
//   - "Log many" is Dave-protected first-class (2026-07-01 directive).
// ORDERING WAS LOAD-BEARING: this row could only be pulled AFTER the header action existed, or
// there is a window with no fast harvest path at all. Both land in the same release.
// "Log an event" reclaims "harvest" in its sub-copy in the same change — the reason it was dropped
// (two harvest-scented rows in one sheet) is gone with the row.
const CREATE_ACTIONS = [
  { to: '/log',          iconName: 'event.other',      label: 'Log an event',   sub: 'A harvest, watering, a note…' },
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
// V4-HARVFABREMOVE-001: '/log?event_type=harvest' dropped with its row — it is matched against
// action.to and no action carries it now, so leaving it would be a dead entry that reads as though
// a harvest row still exists here. The header's Harvest action does not consult this Set at all;
// it uses OverlayLink directly (TopChrome.jsx HeaderActions), and TopChrome.test.jsx pins that its
// href stays byte-identical to the string that used to live here.
const OVERLAYABLE_CREATE = new Set(['/log', '/log/many'])

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

// BUG-BACKNAVMORE-001 (BD-009) — a nav-sheet row that CONSUMES the armed Back entry when it
// navigates. The two BottomNav sheets were deliberately excluded from V4-BACKNAV-001's arming
// (armsBack=false — see lib/backNav.js and Sheet.jsx) because every row here closes the sheet AND
// navigates: a plain push from an armed sheet strands the marker entry MID-STACK
// ([tab, tab+marker, dest]) — a permanent dead Back press on the app's most frequent path, and no
// browser API can remove a mid-stack entry. The cost of NOT arming was the shipped bug: Android
// Back over an open sheet navigated the tab underneath instead of closing the sheet.
// This wrapper resolves the orphaning from the NAVIGATION side so the sheets can finally arm: at
// click time, if the CURRENT history entry is the session marker (readMarker — the same predicate
// disarm() guards on), the row REPLACE-navigates instead of pushing, collapsing the marker entry
// into the destination ([tab, dest]). One Back from the destination lands on the ORIGINAL tab.
// The registry needs no edit: disarm() already treats a replace-while-armed as "marker deleted,
// do nothing" (react-router's replace writes fresh {usr,key,idx} — that guard predates this).
// When the marker is NOT current — flags off, no provider (isolated tests/jsdom without arming),
// or any other reason — the row falls through to the Link's normal push, byte-identical to the
// pre-arming behavior. Modified/non-primary clicks (new tab) also fall through untouched.
function SheetRowLink({ to, overlay = false, onClick, children, ...rest }) {
  const navigate = useNavigate()
  const overlayNavigate = useOverlayNavigate()
  const Comp = overlay ? OverlayLink : Link
  function handleClick(e) {
    onClick?.(e)
    if (e.defaultPrevented) return
    // Mirror Link's own navigation guards: only a plain primary-button click navigates in-tab.
    if (e.button !== 0 || e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return
    if (typeof window === 'undefined' || !window.history) return
    if (!readMarker(window.history.state)) return
    e.preventDefault()
    ;(overlay ? overlayNavigate : navigate)(to, { replace: true })
  }
  return <Comp to={to} onClick={handleClick} {...rest}>{children}</Comp>
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

  // BUG-SIGNOUTBACKRACE-001 — the ONE navigating row in this sheet that is not a SheetRowLink, and
  // therefore the one path the consume-on-navigate gate did not cover when the sheets started
  // arming (v4.13.0, BD-009 / BUG-BACKNAVMORE-001).
  //
  // THE RACE. closeMore() unmounts the Sheet → useDismissable cleanup → disarm() → history.back().
  // A traversal is ASYNC, so it races the replace-navigate below, and BOTH orderings were wrong:
  //   - signOut() deferred (production-dominant — a real network round trip): back() commits first,
  //     so the replace lands on the entry BENEATH the marker. The user reaches '/', but the tab they
  //     came from has been overwritten — it is gone from the back stack.
  //   - signOut() immediate (offline, already signed out, fast reject): the replace lands on the
  //     marker entry first and the queued back() then walks the user one entry BACKWARD, off '/' and
  //     onto a stale authed route while signed out.
  //
  // THE FIX is the gate SheetRowLink already uses, applied here at CLICK TIME — synchronously,
  // before the first await can interleave and before closeMore()'s effects can run. Consuming the
  // marker with a replace makes disarm() a no-op by its own guard (it fires back() only while the
  // marker is still current), so exactly one history write remains on either ordering. Deliberately
  // NOT a timing hack: nothing here depends on when signOut() settles, so both orderings converge.
  // The trailing navigate stays unconditional — it is what lands an UNARMED sign-out (flag off, no
  // provider), and re-replacing '/' with '/' when the gate did fire is inert.
  async function handleSignOutConfirmed() {
    closeMore()
    if (typeof window !== 'undefined' && window.history && readMarker(window.history.state)) {
      navigate('/', { replace: true })
    }
    await signOut()
    navigate('/', { replace: true })
  }

  return (
    <>
      {/* +LOG create action sheet (Sheet primitive). armsBack (BUG-BACKNAVMORE-001): Android Back
          now closes this sheet instead of navigating the tab beneath. Arming is safe here ONLY
          because every row is a SheetRowLink, which consumes the armed entry on row-navigate —
          the orphaning that originally justified the exclusion (see SheetRowLink above). */}
      <Sheet open={showCreate} onClose={closeCreate} ariaLabel="Create new" armsBack>
        <div style={{ padding: '6px 24px 8px', fontSize: '0.8rem', color: P.light }}>
          Add to your garden
        </div>
        {CREATE_ACTIONS.map(action => {
          // V4-OVERLAY-001 Slice 2: /log + /log/many open as flyovers over the current page; /sow and
          // /garden?add=1 stay plain page navigations (§6 — /sow is a page, add-planting is Slice 3).
          // BUG-BACKNAVMORE-001: SheetRowLink keeps that split via `overlay` and consumes the armed
          // Back entry on tap.
          return (
            <SheetRowLink
              key={action.label}
              to={action.to}
              overlay={OVERLAYABLE_CREATE.has(action.to)}
              onClick={closeCreate}
              // V4-HARVFAB-001: the budget guard counts THESE, not links filtered by an href
              // allow-list — an allow-list passes vacuously against exactly the change it is
              // supposed to catch (a new action). See BottomNav.createBudget.test.jsx.
              data-testid="create-action"
              style={{ ...menuRowStyle, padding: '12px 24px' }}
            >
              {/* V4-ICON-001: every CREATE_ACTIONS row carries `iconName`, so the V4-HARVFAB-001
                  glyph-or-iconName fork that used to sit here is gone. A future row without a
                  drawn anchor must draw one, not fall back to a pictographic character. */}
              <Icon name={action.iconName} size={24} decorative style={{ color: P.green }} />
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: '1rem', fontWeight: 600 }}>{action.label}</span>
                <span style={{ fontSize: '0.78rem', color: P.light }}>{action.sub}</span>
              </span>
            </SheetRowLink>
          )
        })}
      </Sheet>

      {/* More menu (Sheet primitive). armsBack (BUG-BACKNAVMORE-001) — same contract as the create
          sheet above: every navigating row is a SheetRowLink. */}
      <Sheet open={showMore} onClose={closeMore} ariaLabel="More navigation options" armsBack>
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
        <SheetRowLink to="/dashboard" onClick={closeMore} style={menuRowStyle}>
          <Icon name="nav.dashboard" size={22} decorative />Dashboard
        </SheetRowLink>
        {/* V4-NAVHARVEST-001 — DrG demoted here from the tab bar. DEMOTED, NOT REMOVED: /findings
            keeps its route, its page and its drawn nav.findings icon, and every deep link into it
            still resolves. It sits beside Dashboard because both are read-only overview surfaces.
            BottomNavDot (the critter poll) is unaffected — it hangs off the nav shell, not this tab. */}
        <SheetRowLink to="/findings" onClick={closeMore} style={menuRowStyle}>
          <Icon name="nav.findings" size={22} decorative />DrG
        </SheetRowLink>
        <SheetRowLink to="/photos" onClick={closeMore} style={menuRowStyle}>
          <Icon name="media.camera" size={22} decorative />Photos
        </SheetRowLink>
        {/* V4-SPACEPHOTO-001 Lane C — a NEW row, above the zones row, because the two are different
            tiers and neither can stand in for the other: "Space" (singular) is the property itself
            (the one `spaces` row), while /locations is the tree of six level-0 ZONES beneath it
            (Deck/Drive/House/Pasture/Stable/Yard, measured live). Re-pointing the existing row would
            have silently stolen /locations' ONLY nav entry — the exact gap V4-PHOTOLOCFIND-001 added
            it to close (only 5 of 913 photos carried a location). Flag-gated, so flag-off renders the
            shipped single row unchanged. V4-ICON-001: the placeholder emoji is now nav.space — the
            row's tier distinction (the property vs the zones beneath it) is carried by two DIFFERENT
            drawn shapes rather than by two house-adjacent pictographs. */}
        {SPACE_PHOTOS_ENABLED && (
          <SheetRowLink to="/space" onClick={closeMore} style={menuRowStyle}>
            <Icon name="nav.space" size={22} decorative />Space
          </SheetRowLink>
        )}
        {/* V4-PHOTOLOCFIND-001 — /locations previously had ZERO nav entries (reachable only
            from Search/Favorites/ProjectNew/ZonePicker — the last since deleted, V4-AMBIENTZONE-001),
            which is half of why only 5 of 913 photos
            carried a location. V4-ICON-001: now facet.location, the pin the rest of the app already
            uses for a zone — the registry entry predates this row, so nothing had to be drawn.
            V4-SPACECLIENTGAP-001 (Dave 2026-08-02): the label is now UNCONDITIONALLY "Zones", not
            flag-conditional. Two rows both reading "Space(s)" pointing at different tiers is the
            §6.8 four-noun drift made worse, and the level-0 rows this page is rooted in ARE zones
            regardless of whether the Space surface is switched on. Naming is a product decision,
            orthogonal to the feature gate: leaving it conditional would mean a rollback silently
            RENAMES a nav row under the user, which is worse than a stable, correct name. Label
            change only; the route and the page are untouched. */}
        <SheetRowLink to="/locations" onClick={closeMore} style={menuRowStyle}>
          <Icon name="facet.location" size={22} decorative />Zones
        </SheetRowLink>
        <SheetRowLink to="/inventory" onClick={closeMore} style={menuRowStyle}>
          <Icon name="nav.inventory" size={22} decorative />Inventory
        </SheetRowLink>
        {/* V4-SOWMOREMENU-001 (BD-067) — Dave: "we seem to have lost the sow now tab, I can't find
            it anywhere", and on where he wants it: "preferably that is just its own listing in the
            more menu, that would be where I'd want it." So: TOP-LEVEL here, directly under Inventory
            rather than nested inside it.
            THIS IS NOT A REGRESSION FIX, and the distinction matters for anyone reading the row.
            Verified on dev/prod v4.57.0 (1c6cf21f71) before building: all three historical entry
            points are alive — the /sow route (App.jsx), the "Sow from seed" action in the create
            sheet (V4-SOWFAB-001, above in this file), and a Sow chip on the Inventory page
            (Inventory.jsx). Nothing was removed. What was missing is a door in the place Dave
            actually looks, and what made it feel VANISHED is that the one sow affordance on his
            highest-traffic screen was plain text with no tap target at all (CultivationLead, now
            fixed). Findability, not restoration.
            ADDITIVE BY SCOPE GUARD: Dave did not ask to consolidate entry points, so the FAB action
            and the Inventory chip both STAY. This is a fourth door, not a replacement — do not
            "tidy" the others away without asking him. That makes it a deliberate exception to the
            redundant-door-pair merging V4-NAVHARVEST-001 does two rows below; the difference is
            that those were two doors to one destination from the SAME surface, while these are one
            door each from four different starting points. */}
        <SheetRowLink to="/sow" onClick={closeMore} style={menuRowStyle}>
          <Icon name="lifecycle.sprout" size={22} decorative />Sow now
        </SheetRowLink>
        {/* V4-NAVHARVEST-001 / V4-PUTUPENGINE-001 — BOTH the Harvests row and the Put-Up row that
            lived here were PROMOTED to the tab bar, not duplicated: two doors to one destination is
            the redundant door-pair the IA work exists to merge. Put-Up's original placement
            (V4-HARVESTCENTER-001, design V101 §6 dec.2 → route under More) is superseded by Dave's
            2026-08-20 ruling; that row was an `overlay` flyover, the tab is a full-page landing.
            The three PREFILL doors are untouched — EventNew PreserveOffer, PutUpFromPlanting and
            PutUpUseSoonBand are content affordances carrying location.state.prefill, not nav rows,
            and they still want the flyover. */}
        <SheetRowLink to="/achievements" onClick={closeMore} style={menuRowStyle}>
          <Icon name="nav.achievements" size={22} decorative />Achievements
        </SheetRowLink>
        {/* Catch-up badge — gated behind CATCH_UP_EDITOR_SHIPPED (currently off).
            BUG-BACKNAVMORE-001 NOTE: if this ever ships, CatchUpBadge's inner link must adopt the
            SheetRowLink consume-on-navigate contract or its tap will orphan the armed Back entry. */}
        {CATCH_UP_EDITOR_SHIPPED && (
          <div data-testid="catch-up-nav-item" onClick={closeMore} style={{ padding: '12px 24px 4px' }}>
            <CatchUpBadge />
          </div>
        )}

        <SectionLabel>Rewards</SectionLabel>
        {/* Critters — ambient reward surface (Reward UX V102): distinguished by placement +
            subtitle, NEVER by a badge/count/alert. */}
        <SheetRowLink
          to="/collection"
          onClick={closeMore}
          style={{ ...menuRowStyle, alignItems: 'flex-start' }}
        >
          <Icon name="nav.critters" size={22} decorative style={{ lineHeight: 1.2 }} />
          <span style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: '1rem', fontWeight: 500 }}>Critters</span>
            <span style={{ fontSize: '0.78rem', color: P.light }}>Who&apos;s been visiting</span>
          </span>
        </SheetRowLink>

        <SectionLabel>Help &amp; account</SectionLabel>
        <SheetRowLink to="/helper" onClick={closeMore} style={menuRowStyle}>
          <Icon name="nav.helper" size={22} decorative />Garden Helper
        </SheetRowLink>
        <SheetRowLink to="/settings" onClick={closeMore} style={menuRowStyle}>
          <Icon name="action.settings" size={22} decorative />Settings
        </SheetRowLink>
        {/* V4-HANDEDNESSCONTROLS-001 (BD-054). Its own row rather than a child of Settings because
            /settings is still the notifications redirect — see SettingsControls.jsx on why the
            /settings parent refactor was deliberately left alone. */}
        <SheetRowLink to="/settings/controls" onClick={closeMore} style={menuRowStyle}>
          <Icon name="action.settings" size={22} decorative />Controls
        </SheetRowLink>
        <SheetRowLink to="/about" onClick={closeMore} style={menuRowStyle}>
          <Icon name="action.info" size={22} decorative />About
        </SheetRowLink>
        <SheetRowLink to="/releases" onClick={closeMore} style={menuRowStyle}>
          <Icon name="nav.notes" size={22} decorative />Release Notes<WhatsNewDot variant="inline" />
        </SheetRowLink>

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

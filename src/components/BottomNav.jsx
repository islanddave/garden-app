import React, { useState, useLayoutEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useOverlayLocation } from '../context/OverlayContext.jsx'
import { readMarker } from '../lib/backNav.js'
import SheetRowLink from './SheetRowLink.jsx'
import { seedsHref } from '../lib/seedsRoutes.js'
import { useAuth } from '../context/AuthContext.jsx'
import WhatsNewDot from './WhatsNewDot.jsx'
import { P, BOTTOM_NAV_HEIGHT_PX } from '../lib/constants.js'
import { T } from '../lib/tokens.js'
import CatchUpBadge from './CatchUpBadge.jsx'
import { PROJECTS_HIDDEN } from '../lib/featureFlags.js'
import { useApiFetch } from '../lib/api.js'
import BottomNavDot from './BottomNavDot.jsx'
import { useMode } from '../lib/mode.js'
import { useKeyboardChromeSuppressed } from '../lib/keyboardChrome.js'
import Sheet from './forms/Sheet.jsx'
import Icon from './Icon.jsx'
import { useNavLayout, useMorePins } from '../context/NavPrefsContext.jsx'
import { layoutMoreSheet, rowPinnable } from '../lib/moreRegistry.js'

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
// `overlayable: true` in App.jsx for the one door that opens it as a flyover: Today's
// PutUpUseSoonBand (overlayNavigate). PutUpFromPlanting's "Log a put-up from this planting" is a plain
// react-router <Link> carrying a prefill — a PAGE navigation, not a flyover — and EventNew's
// PreserveOffer, once a third door, was deleted (V4-PRESERVEOFFERKILL-001). Since V5-NAVCUSTOM-001
// /put-up is in ROOT_TABS, so as a page it carries the root header (no Back arrow) whichever door
// opened it, PutUpFromPlanting and the freezer walk (?session=putup) included: Android Back still
// works and the walk has its own exits. Accepted (regression seat M1). PutUp already defaults a BARE open to its
// 'stores' view, so the tab lands on "what have I got", not on an empty form.
// V5-ADMINCENTER-001 moved THE FIVE ROWS THAT USED TO BE HERE into src/lib/navConfig.js.
// V5-NAVCUSTOM-001 made the bar PER PERSON (D4, Dave 2026-09-24: "only my bar changes" — this
// reverses the 2026-09-08 one-global-order ruling). The slots come from useNavLayout(): this person's
// user_notification_prefs.bar_layout, resolved by resolveBarLayout and drawn from a launch cache at
// first paint, so Jen's bar never shifts because Dave changed his. A person may reorder the five and
// move Garden, Harvests or Put-Up into More — a moved tab is not gone, it is drawn at the top of
// "Your garden" in the More sheet below. Today and the ＋ FAB can never leave. A missing, malformed
// or unreadable layout renders the exact shipped bar. The +LOG FAB is still identified by
// `highlight`, and "More" is still emitted after the map below as a hardcoded button, so it stays
// last by being outside the array entirely — no layout can move it or remove it.

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
  // V5-SEEDSTAB-001 — lands on Seeds › Sow now, the same list /sow used to be, one Back from the tab.
  { to: seedsHref('sow'), iconName: 'lifecycle.sprout', label: 'Sow from seed',  sub: 'Start something from your seed inventory' },
  // V5-HARVESTONEDOOR-001 — THE 'Harvest by voice' ROW IS GONE, AND THE CAP IS BACK TO 4.
  //
  // V5-HARVESTVOICEFLOW-001 added it here on 2026-08-30 as a deliberate fifth row, breaking the
  // stated 4-cap by expansion rather than displacement, and its own note named the exit: "the
  // harvest action already lives in TopChrome... and this row could join it there at no cost to the
  // sheet. That is a placement decision for Dave, not a refactor to do quietly." Dave made that
  // decision on 2026-09-03 — combine the two harvest surfaces into one page and reach it from the
  // header circle — so the row leaves and the cap it broke is restored rather than left at 5.
  //
  // NOTHING IS LOST FROM THIS SHEET. Voice was the ONLY harvest affordance here, and it now sits
  // behind the header circle that renders on every content surface — one tap from anywhere instead
  // of two (open sheet, pick row). The 5-cap guard in the tests goes back to asserting 4.
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

// The More sheet header's "Edit tab bar" door (D3): a text link sized to the 44px floor.
const editBarStyle = {
  display: 'flex', alignItems: 'center', minHeight: 44, padding: '0 16px',
  color: P.green, fontSize: '0.9rem', fontWeight: 600, textDecoration: 'none',
  fontFamily: 'inherit', borderRadius: 8,
}

// BUG-BACKNAVMORE-001 (BD-009) — every navigating row in both sheets below is a SheetRowLink, which
// CONSUMES the armed Back entry when it navigates; that is what lets these sheets arm at all. The
// component moved to ./SheetRowLink.jsx in V5-SEEDSTAB-001 (Saved seeds' track sheet needed it too),
// where the full reasoning now lives.

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

// V5-NAVCUSTOM-001 — THE MORE SHEET IS DATA NOW (src/lib/moreRegistry.js). Each row's history — why
// DrG sits here, why Space is above Zones, why Seeds is one row, why Debug & smoke is last and
// deliberately not client-gated — lives beside that row there. What lives here is how a row is DRAWN,
// and the extras a generic renderer could silently drop are fields the renderer honours (I12): the
// Seeds subtitle and `more-seeds` testid, the Critters subtitle (ambient: never a badge or count,
// Reward UX V102), the What's-New dot on Release Notes.

// The pin button (D2 — Dave chose a button on every row over an edit mode, for both people). A
// SIBLING of the row's SheetRowLink, AFTER it in DOM order, never inside it: a button inside an <a> is
// invalid nested interactive content, and its tap would bubble into the link's consume-on-navigate
// handler, which closes the sheet before it even looks at defaultPrevented. So it stops propagation,
// never navigates, never closes the sheet and never writes history. 48px wide at full row height
// (the 48dp floor); the link keeps the rest of the row, so a tap aimed at a label still opens the page.
// State is carried by SHAPE (outline vs the filled colour pin), by aria-pressed and by the name —
// never by colour alone.
function PinButton({ row, pinned, onToggle }) {
  return (
    <button
      type="button"
      aria-pressed={pinned}
      aria-label={pinned ? `Unpin ${row.label}` : `Pin ${row.label} to the top`}
      data-testid="more-pin"
      data-pin-id={row.id}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(row.id) }}
      style={{
        width: 48, minHeight: 48, alignSelf: 'stretch', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 0, border: 'none', background: 'none', cursor: 'pointer', color: P.light,
      }}
    >
      <Icon name="action.pin" variant={pinned ? 'filled' : undefined} size={22} decorative />
    </button>
  )
}

function RowContent({ row }) {
  const dot = row.adornment === 'whatsNew' ? <WhatsNewDot variant="inline" /> : null
  if (!row.sub) {
    return <><Icon name={row.iconName} variant={row.iconVariant} size={22} decorative />{row.label}{dot}</>
  }
  // Two-line row, the Critters/Seeds style.
  return (
    <>
      <Icon name={row.iconName} variant={row.iconVariant} size={22} decorative style={{ lineHeight: 1.2 }} />
      <span style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: '1rem', fontWeight: 500 }}>{row.label}{dot}</span>
        <span style={{ fontSize: '0.78rem', color: P.light }}>{row.sub}</span>
      </span>
    </>
  )
}

// One More row: the SheetRowLink (every navigating row, pinned and moved ones included — it consumes
// the armed Back entry, BUG-BACKNAVMORE-001) and, when the row is pinnable, its pin button. `note` is
// the inline line under the row ("Unpin one first") — inline because a toast is an interrupt.
function MoreRow({ row, pinned, note, onToggle, onNavigate }) {
  // The catch-up badge (flag-gated off) is a component row: CatchUpBadge renders its own link, so it
  // is not pinnable. BUG-BACKNAVMORE-001 NOTE: if it ever ships, that inner link must adopt the
  // SheetRowLink consume-on-navigate contract or its tap will orphan the armed Back entry.
  if (row.component === 'catchUpBadge') {
    return (
      <div data-testid="catch-up-nav-item" onClick={onNavigate} style={{ padding: '12px 24px 4px' }}>
        <CatchUpBadge />
      </div>
    )
  }
  const linkStyle = {
    ...menuRowStyle, borderTop: 'none', flex: 1, width: 'auto', minWidth: 0,
    ...(row.sub ? { alignItems: 'flex-start' } : null),
  }
  return (
    <div data-more-row={row.id} style={{ borderTop: `1px solid ${P.border}` }}>
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        <SheetRowLink to={row.to} onClick={onNavigate} data-testid={row.testId} style={linkStyle}>
          <RowContent row={row} />
        </SheetRowLink>
        {rowPinnable(row) && <PinButton row={row} pinned={pinned} onToggle={onToggle} />}
      </div>
      {note && (
        <div role="status" style={{ padding: '0 24px 10px 62px', fontSize: '0.8rem', color: P.terra }}>
          {note}
        </div>
      )}
    </div>
  )
}

// V4-NAVACTIVESTATE-001 — the GLYPH's active-state channel, and the reason it is a shape.
//
// Before this, `active` reached only the LABEL: colour (P.green vs P.light) and fontWeight
// (700 vs 400), both riding on a 0.62rem — 9.9px — string. The 22px glyph, the largest and
// most salient thing in each tab, said nothing at all about where you are. So "which tab am
// I on" was answerable only by reading 9.9px text, on an installed PWA held at arm's length.
//
// WHAT IT IS NOT, and why not:
//   - NOT a re-tint of the glyph. The note at the tab's <Icon> below is right and stands: a
//     multi-region colour glyph re-tinted by tab state collapses every region to one hue.
//   - NOT a bigger label. design-designsys-icons-PLAN-V101 §6 records that the whole type
//     ramp already sits below the floor adhd-style-guide.md declares, so widening downward
//     (or upward) there is a legibility decision Dave owns, not a fix to make in passing.
//   - NOT a third colour signal. The channel is the ENCLOSURE — present on the active tab,
//     absent everywhere else. Presence-vs-absence of a shape survives greyscale and a
//     peripheral glance, which is exactly what two colour-and-weight signals on 9.9px text
//     do not.
//
// WHY A RING AROUND A PALE FILL rather than the solid pill the spec sketches: P.greenPale
// #d8f3dc is 1.15:1 against this bar's white and would be near-invisible carrying the signal
// alone, while a fill dark enough to read on its own (P.sage, 3.14:1) drops the glyph's own
// authored regions under the 3:1 silhouette floor they were each measured against
// (ICON_COLORS in lib/tokens.js; gated by iconColorNav.test.jsx). The green ring carries the
// shape at ~6:1; the pale fill gives it body and leaves every tab-glyph region above 3:1
// (the lowest, navRow #6f8a78, goes 3.46:1 on cream -> 3.21:1 on greenPale).
//
// ABSOLUTELY POSITIONED, so it costs zero layout: the glyph does not move, grow or reflow
// when a tab becomes active, and switching tabs shifts nothing inside a 56px bar. That is
// also why the wrapper renders unconditionally and only the indicator is conditional.
const activeIndicatorStyle = {
  position: 'absolute',
  top: -T.space.xs, bottom: -T.space.xs, left: -T.space.sm, right: -T.space.sm,
  borderRadius: T.radiusPill,
  backgroundColor: P.greenPale,
  border: `1px solid ${P.green}`,
  pointerEvents: 'none',
}

// One glyph slot for every bottom-bar tab INCLUDING More, deliberately: More already takes
// the same two label channels from `showMore` that the five destinations take from `active`,
// and a tab that goes green-and-bold with no indicator reads as a bug rather than as a rule.
// (On More the BottomNavDot sits above the indicator — later in DOM order, so it still paints
// on top — and the sheet it belongs to is covering the bar anyway.)
function TabGlyph({ iconName, variant, active }) {
  return (
    <span style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {active && <span data-testid="nav-active-indicator" aria-hidden="true" style={activeIndicatorStyle} />}
      <Icon name={iconName} variant={variant} size={22} decorative style={{ position: 'relative' }} />
    </span>
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
  // V5-NAVCUSTOM-001 — this person's bar: their order, minus the tabs they moved into More. Falls
  // back to the shipped five with no provider mounted, which is what every isolated component test
  // renders against. `moved` are those tabs; the More sheet draws them. `canEditBar` is the server's
  // can_edit_bar (D3 — Dave only today), never a client list.
  const { bar: tabs, moved, canEditBar } = useNavLayout()
  const { pins, togglePin } = useMorePins()
  const [showMore, setShowMore]             = useState(false)
  const [showCreate, setShowCreate]         = useState(false)
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  // I11 — THE SHEET'S ROWS ARE FROZEN WHEN IT OPENS. A pin tap flips that row's button at once, but
  // nothing moves until the next open: a row jumping to the top would slide every row under the thumb
  // that is about to tap one. Pins that land from the server while the sheet is open wait likewise.
  const [sheet, setSheet]                   = useState(null)
  const [pinNote, setPinNote]               = useState(null)   // { id, text } — inline, at that row
  const moreOpen = useRef(false)
  moreOpen.current = showMore

  function isActive(path) {
    return location.pathname === path || location.pathname.startsWith(path + '/')
  }

  function closeMore() {
    setShowMore(false)
    setConfirmSignOut(false)
    setPinNote(null)
  }

  function toggleMore() {
    closeCreate()
    if (!showMore) setSheet(layoutMoreSheet({ pins, moved }))
    setShowMore(!showMore)
  }

  // 'full' and 'error' answer at the row that was tapped, in words, and only while the sheet is still
  // open to show them — never as a toast.
  async function onTogglePin(id) {
    setPinNote(null)
    const outcome = await togglePin(id)
    if (!moreOpen.current) return
    if (outcome === 'full') setPinNote({ id, text: 'Unpin one first' })
    else if (outcome === 'error') setPinNote({ id, text: 'Not saved. Try again.' })
  }

  // The snapshot is set on open; the fallback only covers a render before the first open.
  const view = sheet ?? layoutMoreSheet({ pins, moved })
  const renderRow = (row) => (
    <MoreRow
      key={row.id}
      row={row}
      pinned={pins.includes(row.id)}
      note={pinNote?.id === row.id ? pinNote.text : null}
      onToggle={onTogglePin}
      onNavigate={closeMore}
    />
  )

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
          the orphaning that originally justified the exclusion (see ./SheetRowLink.jsx). */}
      <Sheet open={showCreate} onClose={closeCreate} ariaLabel="Create new" armsBack>
        <div style={{ padding: '6px 24px 8px', fontSize: '0.8rem', color: P.light }}>
          Add to your garden
        </div>
        {CREATE_ACTIONS.map(action => {
          // V4-OVERLAY-001 Slice 2: /log + /log/many open as flyovers over the current page; Seeds and
          // /garden?add=1 stay plain page navigations (§6 — Seeds is a page, add-planting is Slice 3).
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
          sheet above: every navigating row is a SheetRowLink, including the header's "Edit tab bar"
          door and every pinned and moved row. V5-NAVCUSTOM-001 — top to bottom: the name line, this
          person's Pinned block, View mode, "Your garden" (moved tabs first), Rewards, Help & account,
          Debug & smoke, Sign out. The rows are the snapshot taken when the sheet opened (I11). */}
      <Sheet
        open={showMore}
        onClose={closeMore}
        ariaLabel="More navigation options"
        armsBack
        headerStart={canEditBar === true ? (
          // D3 — the bar editor's everyday door, in the header's empty left slot, shown only when the
          // server says this person may use it (can_edit_bar; Dave only today). Debug & smoke →
          // App configuration stays as the second door (the /admin reachability rule).
          <SheetRowLink to="/admin/config" onClick={closeMore} data-testid="more-edit-tab-bar" style={editBarStyle}>
            Edit tab bar
          </SheetRowLink>
        ) : null}
      >
        {/* Signed-in identity */}
        <div style={{ padding: '4px 24px 12px', fontSize: '0.8rem', color: P.light }}>
          {profile?.display_name || profile?.email || 'Signed in'}
        </div>

        {/* D1 — THIS person's pins, in pin order, at most four. A pinned row is drawn HERE and not at
            home, and goes back to its home slot when unpinned. No block at all until something is
            pinned, so nobody's sheet changes until they pin. */}
        {view.pinned.length > 0 && (
          <div data-testid="more-pinned">
            <SectionLabel>Pinned</SectionLabel>
            {view.pinned.map(renderRow)}
          </div>
        )}

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

        {view.sections.map(section => section.rows.length > 0 && (
          <React.Fragment key={section.key}>
            {section.label && <SectionLabel>{section.label}</SectionLabel>}
            {section.rows.map(renderRow)}
          </React.Fragment>
        ))}

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
        {tabs.map(tab => {
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
              {/* V4-ICONCOLOR-001 tab-bar pass (Dave 2026-08-28). `filled` is the colour variant;
                  the four browse tabs are the ONLY consumer that asks for it, which is what keeps
                  nav.garden mono where iconEvents.js:78 reuses it for potting_up on the timeline.
                  Dave: "there were two with nice color/style - harvest and put up - which I thought
                  we would match other items to - we've regressed afaict" — 0bddf91 had replaced
                  those two emoji with mono line art for set-completeness, levelling DOWN the only
                  two coloured tabs instead of levelling the rest up.
                  NO `style` colour here, deliberately: a colour glyph must not be re-tinted by tab
                  state or every region collapses back to one hue. Active/inactive is carried by the
                  LABEL's colour and weight below, by aria-current on the Link, and — since
                  V4-NAVACTIVESTATE-001 — by the indicator TabGlyph draws behind the glyph, which is
                  the one channel of the three that does not need 9.9px text or hue to be read. */}
              <TabGlyph iconName={tab.iconName} variant="filled" active={active} />
              <span style={{ fontSize: '0.62rem', fontWeight: active ? 700 : 400 }}>{tab.label}</span>
            </Link>
          )
        })}

        <button onClick={toggleMore}
          aria-expanded={showMore} aria-label="More navigation options"
          style={{
            flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 2, background: 'none', border: 'none', cursor: 'pointer',
            color: showMore ? P.green : P.light, padding: 0, minHeight: 44, position: 'relative',
          }}>
          <TabGlyph iconName="nav.more" active={showMore} />
          <span style={{ fontSize: '0.62rem', fontWeight: showMore ? 700 : 400 }}>More</span>
          {/* Critter "new visitor" dot lives on More now that Critters is in the menu. */}
          <BottomNavDot getToken={getToken} />
        </button>
      </nav>
    </>
  )
}

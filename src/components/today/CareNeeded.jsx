import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { P } from '../../lib/constants.js'
import { SEVERITY_STYLES } from '../../lib/waterDue.js'
import { useApiFetch } from '../../lib/api.js'
import { useCachedFetch } from '../../hooks/useCachedFetch.js'
import { useOptionalToast } from '../../context/ToastContext.jsx'
import { useAuthOptional } from '../../context/AuthContext.jsx'
import GroupByControl from '../forms/GroupByControl.jsx'
import Sheet from '../forms/Sheet.jsx'
import Icon from '../Icon.jsx'
import PhotoView from '../photo/PhotoView.jsx'
import { TIER } from '../../lib/photoModel.js'
import {
  buildCareNeeded, groupRows, bedWaitActive, autoExpandKeys, capStaleRows,
  dormantRows, feedSuppressedRows, FEED_SUPPRESSED_LISTED, droughtRows,
  NEED_EVENT_TYPE, NEED_LABEL, NEED_ORDER, EXPAND_ROW_BUDGET, WATER_STALE_CAP, splitContainersBeds,
  canMoistureCheck, candidateKeys,
} from '../../lib/careNeeded.js'
import { useCareActions } from './useCareActions.js'
import { visitLayoutKey, readVisitLayout, writeVisitLayout } from './visitLayout.js'

// CareNeeded — Slice 7 (V4-THEME-001) Care-Needed-Today. REPLACES the care-type PlanBuckets:
// location-grouped (default) need rows with ONE-TAP inline logging, per-need bulk, undo, and a
// suppress-for-today "skip". Operational surface (Reward-UX V101 §7): ambient only — no
// celebration / streak / badge / interrupt; the undo toast is operational, not a reward.
//
// Read-path parity: ALL "which plantings / which need / what order" logic lives in careNeeded.js
// (buildCareNeeded). This component only renders what that canonicalizer emits + owns interaction
// state. The care state and write paths it drives live in useCareActions.js, and the page's one skip
// set in careStore.js (V5-TODAYREDESIGN-001 S1). One-tap log goes through the IDENTICAL Log-form
// write path (POST /api/events) so the events Lambda side effects (critter award +
// entity_memory.next_water_at) fire; undo soft-deletes.

const GROUP_OPTS = [
  { value: 'location', label: 'By location' },
  { value: 'type', label: 'By type' },
]

// Stable identity for "no enrichment yet" so enrichedRows doesn't re-memo on every render.
const NO_ENRICHMENT = Object.freeze({})

// BUG-TODAYGROUPREORDER-001 — one TAKEN layout: the section order and the sections that open on it,
// from groups already ranked by groupRows. null when there is nothing to lay out, so the first plan
// that does carry work takes a real one instead of inheriting an empty order. See CareNeeded.
function takeLayout(rankedGroups, basis) {
  if (!rankedGroups.length) return null
  return { basis, order: rankedGroups.map(g => g.key), expand: autoExpandKeys(rankedGroups, EXPAND_ROW_BUDGET) }
}
const NO_LAYOUT = Object.freeze({ basis: null, order: Object.freeze([]), expand: new Set() })

// BD-036b — the care chip IS the log button.
//
// It used to be a status chip sitting inside the row body, with a separate solid-green "Log" button
// to its right. Dave's read: those two are redundant. The chip already carries the severity colour
// that says how urgent this is, and the thing you want to tap is the thing that is coloured. So the
// chip absorbed the action and the Log button is gone — which also buys back ~64px of width on a
// 390px screen and removes a control from every row.
//
// Still three channels, unchanged (SC 1.4.1): mono event icon + text verb + token colour. Colour is
// never the only carrier. It keeps the SEVERITY_STYLES tokens so the Today row and the detail
// CareStatus band still cannot disagree.
//
// The accessible NAME stays exactly "Log Water for X". Appending the reason to it was the obvious
// first move and it was wrong twice over: it silently broke every caller matching /^Log Water for
// X$/ (four of this repo's own tests caught it), and a name that grows a clause is a worse name —
// AT announces it on focus, in bulk lists, and in the rotor. The reason travels as visually-hidden
// text in the row body instead (see Row), which is where a screen reader meets it in reading order
// anyway. That keeps the urgency signal available to someone who gets no colour at all, without
// renaming the control.
function CareChipButton({ row, pending, onLog }) {
  const s = SEVERITY_STYLES[row.tier] || SEVERITY_STYLES.gold
  return (
    <button
      type="button" onClick={() => onLog(row)} disabled={pending}
      aria-label={'Log ' + NEED_LABEL[row.need] + ' for ' + row.name}
      style={{
        flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        minWidth: 78, minHeight: ROW_TAP_MIN, border: 'none', borderLeft: '1px solid ' + P.border,
        background: pending ? P.greenPale : s.bg, color: pending ? P.green : s.text,
        fontWeight: 700, fontSize: '0.8rem', cursor: pending ? 'default' : 'pointer',
      }}
    >
      {pending ? '…' : <><Icon name={'event.' + row.eventType} size={15} decorative style={{ color: s.text }} />{NEED_LABEL[row.need]}</>}
    </button>
  )
}

// The floor on row height, and the reason it is a named constant rather than a number inlined three
// times. Dave asked for the rows to lose "a third or even half" of their height. A third is
// available and is what this delivers; half is not, and the binding constraint is not taste.
//
// The old row ran ~69px: a 48px control band plus a second text line plus 10px of vertical padding.
// Dropping the reason line and the padding collapses it ONTO the control band. Below that, the
// thing that shrinks is the tap target, and Dave is on Android where Material's minimum is 48dp.
// So 48 is the floor, and the row is now exactly its buttons — no whitespace left to give back.
const ROW_TAP_MIN = 48

// BUG-TODAYSKIPNOUNDO-001 — Skip's target, and the dead space that separates it from the next control.
// Skip was 42px wide and flush against Moist or Water: under Android's 48dp minimum, and a thumb that
// missed it by a few pixels wrote an event instead of skipping. 48 wide matches ROW_TAP_MIN, so the
// target is 48 in both directions. The 8px after it is Material's minimum spacing between targets and
// is deliberately NOT tappable — a near-miss does nothing, rather than log a watering.
// THE COST, measured in real Chrome at Dave's 426px viewport (tests/harness/careskip.*): the name
// column on a water row goes 204 -> 190px (166 -> 152 beside a thumbnail). Against the 253 live care
// rows of 2026-09-24 that ellipsizes 11 more names, all 20-23 characters — 37 cut instead of 26.
// SKIP_GAP is the dial: 4 would cut 8 more instead of 11, 0 would cut 3 but drop the separation.
const SKIP_W = 48
const SKIP_GAP = 8

// Same shape as the one in forms/PlantingSelect.jsx. NOT `display:none` and not width/height 0 —
// both remove the node from the accessibility tree, which would defeat the entire point.
const SR_ONLY = {
  position: 'absolute', width: 1, height: 1, overflow: 'hidden',
  clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap',
}

// BUG-MOISTURECHECKNOBUTTON-001 — "I checked it, it's still moist."
//
// A real <button>, never a <div aria-label>. A generic role cannot be named, so the label on a
// role-less div is dropped outright and the control reaches AT as an unlabelled node.
//
// Quiet green, not a severity colour. It is a log action like the care chip, so it carries the
// green token family rather than Skip's bare text — but it must not compete with the chip for the
// eye. BD-036b made "the thing you want to tap is the thing that is coloured" the rule of this row,
// and the thing you want to tap is still Water; this is the exception you take when you get there
// and find the soil damp. The green tint is also what separates it from the visually similar Skip
// sitting next to it, which writes nothing at all.
//
// 48px wide so the target clears 44px in BOTH axes (ROW_TAP_MIN covers the vertical). Text-labelled
// rather than icon-only: an unfamiliar glyph carries no channel a screen reader or a hurried thumb
// can use, and "Moist" is one word wide.
function MoistureButton({ row, pending, onMoist }) {
  return (
    <button
      type="button" onClick={() => onMoist(row)} disabled={pending} data-testid="care-moist"
      aria-label={'Checked ' + row.name + ' — still moist'}
      style={{
        flexShrink: 0, width: 48, minHeight: ROW_TAP_MIN, border: 'none',
        borderLeft: '1px solid ' + P.border, background: pending ? P.greenPale : 'none',
        color: P.green, fontWeight: 600, fontSize: '0.7rem',
        cursor: pending ? 'default' : 'pointer',
      }}
    >
      {pending ? '…' : 'Moist'}
    </button>
  )
}

function Row({ row, pending, onLog, onSkip, onMoist }) {
  const detailHref = (row.projectId && row.plantingId)
    ? '/projects/' + row.projectId + '/plantings/' + row.plantingId
    : '/garden'
  return (
    <div data-testid="care-row" style={{ display: 'flex', alignItems: 'stretch', borderTop: '1px solid ' + P.border }}>
      {/* Secondary zone: open detail (whole row body). */}
      <Link to={detailHref} style={{
        flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 10px', textDecoration: 'none', color: P.dark, minHeight: ROW_TAP_MIN,
      }}>
        {row.photo && (
          <PhotoView photo={row.photo} tier={TIER.THUMB} alt="" style={{ width: 30, height: 30, borderRadius: 6, objectFit: 'cover', flexShrink: 0, border: '1px solid ' + P.border }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.9rem', fontWeight: 600, color: P.dark, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.name}
          </div>
          {/* The reason line is now conditional — it is what made the row two lines tall. It prints
              only when it says something the chip colour cannot: a rain note, "Never watered", a
              long-gap daily record, a pest label. A bare "3d overdue" is the tier restated in words
              (terra-bold IS >=3d), so on the water rows that dominate this list it is gone. */}
          {!row.reasonRedundant && row.reason && (
            <div style={{ fontSize: '0.74rem', color: P.light, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row.reason}
            </div>
          )}
          {/* Dropped from SIGHT, not from the page. The tier colour replaces this text for sighted
              users; a screen-reader user gets no colour, so removing it outright would have made
              the row strictly less informative for them than before the redesign. */}
          {row.reasonRedundant && row.reason && <span style={SR_ONLY}>{row.reason}</span>}
        </div>
      </Link>
      {/* Skip (suppress-for-today) — quiet secondary control, to the LEFT of the care chip. */}
      <button type="button" onClick={() => onSkip(row)} aria-label={'Skip ' + row.name + ' today'}
        style={{ flexShrink: 0, width: SKIP_W, marginRight: SKIP_GAP, minHeight: ROW_TAP_MIN, border: 'none', borderLeft: '1px solid ' + P.border, background: 'none', color: P.light, cursor: 'pointer', fontSize: '0.7rem' }}>
        Skip
      </button>
      {/* Ordered by escalating commitment left-to-right: do nothing today -> record what you found
          -> record the watering. Only water_due rows carry the middle one (canMoistureCheck). */}
      {canMoistureCheck(row) && <MoistureButton row={row} pending={pending} onMoist={onMoist} />}
      <CareChipButton row={row} pending={pending} onLog={onLog} />
    </div>
  )
}

function SubHeader({ label }) {
  return (
    <div style={{ padding: '6px 14px 2px', fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: P.light, background: P.white }}>{label}</div>
  )
}

function Group({ group, expanded, onToggle, pendingKeys, onLog, onSkip, onMoist, mode, onShowAll, groupBulk, onGroupBulk, bulkBusy }) {
  const panelId = 'care-group-' + group.key
  return (
    <div data-testid="care-group" style={{ border: '1px solid ' + P.border, borderRadius: 12, background: P.white, overflow: 'hidden' }}>
      {/* V4-TODAYSECTIONBULK-001 (BD-037) — the section bulk sits BESIDE the disclosure, not inside
          it: nesting a button in a button is invalid, and the toggle must stay the whole-width
          target it already is. Same three-zone shape as Row (body | secondary | primary action), so
          the header reads as one control strip rather than a new panel. */}
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        <button type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={panelId}
          style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0, textAlign: 'left', padding: '12px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: P.dark, minHeight: 52 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: '0.98rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.label}</span>
          {/* TRUE count, never the capped one — the staleness cap changes what renders, not what exists. */}
          <span style={{ fontSize: '0.78rem', fontWeight: 800, color: P.green, background: P.greenPale, borderRadius: 999, padding: '2px 9px' }}>{group.count}</span>
          <span aria-hidden="true" style={{ color: P.light, transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
        </button>
        {groupBulk.map(b => (
          <button key={b.eventType} type="button" disabled={bulkBusy}
            onClick={() => onGroupBulk(b.eventType, b.keys)}
            aria-label={b.verb + ' all ' + b.keys.size + ' in ' + group.label}
            style={{ flexShrink: 0, minHeight: 52, border: 'none', borderLeft: '1px solid ' + P.border, background: P.greenPale, color: P.green, padding: '0 12px', fontWeight: 700, fontSize: '0.78rem', cursor: bulkBusy ? 'default' : 'pointer' }}>
            {b.verb} all
          </button>
        ))}
      </div>
      {/* V5-TODAYSHAPE-001 — THE `<div id={panelId}>` BELOW is the measured blind spot the Today
          layout gate exists for. Adding `style={{height:0,overflow:'hidden'}}` to it clips the
          whole care list to nothing, and 9,239 of 9,241 unit tests still passed when that was
          measured (2026-09-08), because jsdom has no layout engine; `display:none` on the same line
          kills 18. The gate asserts checkVisibility() AND a non-zero rect per `care-row`, in real
          Chrome, which is the only place that difference is observable. Mutant `clipRowPanel` in
          tests/harness/todayMutants.mjs re-proves it on demand. */}
      {expanded && (
        <div id={panelId} data-testid="care-group-panel" role="list">
          {(() => {
            const R = (r) => <Row key={r.key} row={r} pending={pendingKeys.has(r.key)} onLog={onLog} onSkip={onSkip} onMoist={onMoist} />
            if (mode === 'location') {
              const { beds, containers } = splitContainersBeds(group.rows)
              // Only show the sub-split when a location actually mixes both lanes.
              if (beds.length && containers.length) {
                return (
                  <>
                    <SubHeader label={'Containers & pots (' + containers.length + ')'} />
                    {containers.map(R)}
                    <SubHeader label={'In-ground & beds (' + beds.length + ')'} />
                    {beds.map(R)}
                  </>
                )
              }
            }
            return group.rows.map(R)
          })()}
          {group.hidden > 0 && (
            <button type="button" onClick={onShowAll} data-testid="care-show-more"
              style={{ display: 'block', width: '100%', minHeight: 44, borderTop: '1px solid ' + P.border, border: 'none', background: 'none', color: P.green, fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer' }}>
              Show {group.hidden} more
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default function CareNeeded({ plan, planDate, list = 'own' }) {
  // getToken comes off useApiFetch rather than useAuth directly — that is the documented seam
  // (api.js:160): every component test already mocks useApiFetch, so routing token acquisition
  // through it keeps the Clerk/AuthProvider dependency out of this component's tests. Importing
  // useAuth here instead reds all 14 CareNeeded cases with "must be used inside <AuthProvider>".
  const { fetch, getToken } = useApiFetch()
  const toast = useOptionalToast()
  // BUG-TODAYBACKRESORT-001 — the layout this list held earlier on this plan day, in this tab
  // (visitLayout.js), read ONCE, at mount: Back from a planting remounts Today. Pending until the
  // reconcile below adopts it. useAuthOptional, not useAuth, for the reason above: no provider means
  // no user, no key and nothing held (useCachedFetch already reads it the same way). `list` names
  // whose list this is — 'own', or the household member's id — so each list holds its own order.
  const { user } = useAuthOptional()
  const visitKey = visitLayoutKey(user?.id, planDate, list)
  const [visit, setVisit] = useState(() => readVisitLayout(visitKey))
  const [mode, setMode] = useState(() => (visit ? visit.mode : 'location'))
  const [bulkType, setBulkType] = useState(null)          // event_type whose bulk fly-up is open
  const liveRef = useRef(null)
  const announce = useCallback((msg) => { if (liveRef.current) liveRef.current.textContent = msg }, [])
  const closeBulk = useCallback(() => setBulkType(null), [])
  const allRows = useMemo(() => buildCareNeeded(plan), [plan])
  const bedWait = useMemo(() => bedWaitActive(plan), [plan])
  // The care state and every write path — the fades (`logged`) and their new-day reset, the in-flight
  // guards, the page's one skip set and its mount-time server merge, Log / Moist / Skip / bulk and
  // their undo — live in useCareActions.js (V5-TODAYREDESIGN-001 S1), shared with the V2 Today.
  // Called here, ahead of the two fetches below, so its merge effect keeps its place in effect order.
  // `rows` is `allRows` minus what is logged and skipped: the list as it stands.
  const {
    skipped, rows, pendingKeys, bulkProgress, setBulkProgress, candidatesFor, logRow, moistRow, skipRow, runBulk,
  } = useCareActions({ allRows, bedWait, planDate, fetch, getToken, toast, announce, onBulkEnd: closeBulk })
  const [overrides, setOverrides] = useState(() => ({}))  // explicit per-group expand/collapse
  const [bulkChecked, setBulkChecked] = useState(() => new Set())

  // V4-TODAYLOC-001 — best-effort enrichment for true location grouping + thumbnails. Joins
  // /api/plants (location_id, container_type, featured thumb) with /api/locations/with-path
  // (id -> full_path name). Degrades silently to project-proxy grouping if either fetch fails.
  //
  // /api/plants goes through dataCache so this shares ONE request with StorageDeadlineAlert (and
  // with the sibling CareNeeded that the household lens mounts per caretaker) instead of each
  // instance pulling its own ~0.5-1 MB copy of the same 243-row list on one paint.
  const { data: plants } = useCachedFetch('/api/plants')
  // Tri-state on purpose: undefined = not settled, null = settled-but-failed, array = settled ok.
  const [locPaths, setLocPaths] = useState(undefined)
  useEffect(() => {
    let alive = true
    Promise.resolve().then(() => fetch('/api/locations/with-path'))
      .catch(() => null)
      .then(d => { if (alive) setLocPaths(Array.isArray(d) ? d : null) })
    return () => { alive = false }
  }, [fetch])

  // Enrich only once BOTH sources have settled. The previous Promise.all made that atomicity
  // implicit; splitting the fetches makes it load-bearing, because groupRows derives a group's KEY
  // from locationId but its LABEL from locationName — so applying plants before the paths land
  // would show each group under its project name for a beat and then flip it to the location name.
  const enrichById = useMemo(() => {
    if (locPaths === undefined || !Array.isArray(plants)) return NO_ENRICHMENT
    const nameById = new Map()
    if (Array.isArray(locPaths)) for (const l of locPaths) nameById.set(l.id, l.full_path || l.name || null)
    const map = {}
    for (const pl of plants) {
      map[pl.id] = {
        locationId: pl.location_id || null,
        locationName: (pl.location_id && nameById.get(pl.location_id)) || null,
        containerType: pl.container_type || null,
        // BUG-TIERLESSPHOTOS-001 — a photo-shaped row for <PhotoView>, not a hand-picked URL. This
        // used to be `thumb: pl.featured_photo_view_url`: a field NAMED thumb holding the full
        // ORIGINAL, painted into a 30px box (79 device px at Dave's dpr) on the post-login landing
        // route, on a list that runs to ~200 rows. /api/plants signs the thumbs/ companion on the
        // SAME row (lambda/plants featuredPhotoUrls) and it was simply never read.
        //
        // Handing over the raw fields rather than a chosen URL is the whole point: photoModel maps
        // featured_photo_thumb_url -> THUMB and featured_photo_view_url -> FULL, so tier=THUMB is a
        // two-entry chain and the 16.5% of photos with no thumb OBJECT (BUG-PHOTONEWTHUMB-001 —
        // thumb_url is a non-empty presigned string on all 1094 rows either way) degrade to the
        // original on load failure with ZERO network, because the fallback came down in this same
        // response. Picking here with `||` would be the bug this ticket is named for.
        //
        // The PHOTO id, never the planting id: photoId feeds the 900s-presign self-heal against
        // /api/photos/view-url/<id>, so conflating the two would 404 every heal (the hazard
        // PlantingTile's adapter documents). plant_id is the photo's real parent.
        photo: pl.featured_photo_view_url ? {
          id: pl.featured_photo_id ?? null,
          featured_photo_view_url: pl.featured_photo_view_url,
          featured_photo_thumb_url: pl.featured_photo_thumb_url ?? null,
          plant_id: pl.id,
        } : null,
      }
    }
    return map
  }, [plants, locPaths])

  const enrich = useCallback(
    (r) => { const e = enrichById[r.plantingId]; return e ? { ...r, ...e } : r },
    [enrichById],
  )
  const enrichedRows = useMemo(() => rows.map(enrich), [rows, enrich])
  // BUG-TODAYCAREREORDER-001 (BD-036) — the ordering set. Deliberately NOT `rows`: it withholds
  // `skipped` but keeps `logged`, so a ranking taken from it is a property of the plan rather than
  // of how far through it Dave is. Logging is the side effect he named — tapping Log down a location
  // group dropped that group's summed severity and slid the section out from under his finger onto
  // the next plant. Skips are withheld because they persist all day across devices, so counting them
  // would rank a group by work already declined.
  //
  // BUG-TODAYGROUPREORDER-001 — this set used to be ranked LIVE, and a skip was allowed to move the
  // page: BD-036 read "an explicit user action" as including a skip. Dave narrowed that on
  // 2026-09-17 to the By location / By type control, never a side effect of log, skip or mark moist.
  // It is now read only when the layout below is TAKEN, not on every change.
  const orderingRows = useMemo(
    () => allRows.filter(r => !skipped.has(r.key)).map(enrich),
    [allRows, skipped, enrich],
  )
  // Length cap: each group renders at most WATER_STALE_CAP water rows until Dave asks for the rest,
  // and the note below says rows were withheld (V5-TODAYCAP-001 below explains why this no longer
  // depends on whether the watering record is stale).
  //
  // The cap is applied PER GROUP, after grouping. Capping the flat row list globally (most-overdue
  // first) would undo the group-severity fix in the same breath: on live 2026-08-17 the 20
  // most-overdue rows are 4 from a 4-row outlier group and 14 from the 116-row one, so the outlier
  // group would win the severity sort again inside the capped set. Per-group keeps the ordering
  // honest and puts the cap exactly where the wall is.
  //
  // The cap does NOT touch the bulk candidate set below. "Log all watering (194)" is Dave asserting
  // what HE did — an input, not a claim this surface is making — and 92% of his watering goes
  // through that one action, so taxing it to make a display point would be the wrong trade.
  const [showCapped, setShowCapped] = useState(false)
  // V5-TODAYCAP-001 — cap by LENGTH always, not only when the record is stale.
  //
  // Page length and record staleness are two different questions that were sharing one switch, and
  // the switch was wired to the wrong one. `waterStaleness` asks "is this list resting on
  // absence-of-record?" — an honesty question, median days_since >= 3. How many rows a phone should
  // render is a UI question and has nothing to do with it.
  //
  // The cost of conflating them, measured on live prod: Dave's median days_since is 2, so
  // `staleness.stale` is FALSE, so nothing capped, so the lead group rendered all 70 water rows —
  // 4,564px of a 6,232px page, 73% of Today — while `Show {group.hidden} more` sat on screen as dead
  // code, because `hidden` is only ever non-zero when capping ran. Inverted on a stale day: a 5-row
  // group would be "capped" at 20, a no-op. The affordance was built for a different question.
  //
  // Capping ALWAYS makes both cases right and removes ~2,450px. Deliberately narrow:
  //   · `capStaleRows` withholds `water_due` rows ONLY. never-watered, pest, feed and cold rows are
  //     not on the watering clock and all still render.
  //   · Rows arrive most-overdue-first, so the 20 kept are the longest-waiting — King of the North at
  //     26 days stays visible, its 71 identical siblings at 2 days are what collapses.
  //   · The group header keeps the TRUE count and `bulkRows` stays UNCAPPED, so "Log all watering
  //     (194)" still logs everything. The cap withholds rows from the display, not from the garden.
  //   · Still an input to `pinnedGroups` below, computed from the arrival snapshot, so this does NOT
  //     re-open BUG-TODAYCAREREORDER-001 (a section sliding out from under his finger).
  // The honesty job belongs to the per-row "last watered Nd ago" labels, which careNeeded.js builds
  // for each row; record staleness no longer decides page length here. Zero watering-LOGIC changes,
  // per the crucible boss ruling: the work is legibility.
  const capping = !showCapped
  // BD-036 — the layout supplies BOTH the section order and the auto-expand set, because both were
  // functions of the draining list: autoExpandKeys walks groups filling a row budget, so logging
  // rows out of a group freed budget and silently opened a collapsed section further down the page —
  // the same finger-level movement as the re-sort, from a second source.
  //
  // BUG-TODAYGROUPREORDER-001 — the layout is TAKEN when Today opens and HELD for the visit. BD-036
  // pinned it to `orderingRows` but re-derived it on every change, which froze it against LOGGING
  // only: a skip moved it on purpose, and every plan refetch moved it by accident. useDailyPlan
  // revalidates on each wake (BUG-PLANNOREVALIDATE-001), the read path stamps what Dave has logged
  // as `done`, and the ranking then ran against a list with his work taken out — he logged, put the
  // phone in his pocket, and came back to the sections in a different order. That is the "every
  // action" report of 2026-09-17: the swing arrived with the refetch, not with the tap.
  //
  // Re-taken ONLY on:
  //   · a tap on By location / By type — either one, including the one already selected, which is
  //     how he re-sorts on purpose, as often as he likes. Ranked over the rows ON THE LIST NOW
  //     (`enrichedRows`), because a sort he asked for should reflect the work that is left.
  //   · when the location names land, one round trip after the plan (`enrichById` settling; also when
  //     that fetch fails). That re-keys every group from project to location, a different set of
  //     sections, so there is no old order to keep. Ranked from `orderingRows`, so a log made before
  //     the names land cannot move anything (a skip made in that window does count).
  //   · a clean slate: nothing the layout holds is on the list any more (all done, new work in).
  //     There is nothing on screen to move.
  //   · a new plan day — the reset below.
  // Opening Today again remounts this component. BUG-TODAYBACKRESORT-001 — that is not a re-take either
  // for the rest of the plan day in this tab: the held layout and the open set go to visitLayout.js
  // whenever they change, and the remount adopts them (see the reconcile below). A new tab, no signed-in
  // user or no plan date is still a fresh take.
  //
  // Between takes, a section that empties is not drawn but keeps its slot, so it comes back where it
  // was — on Undo, or when a later refetch refills it. By location, a section seen for the first
  // time is APPENDED at the end and remembered there, so a later drain cannot swap it with its
  // neighbour. By type: a new section takes its fixed need slot (groupRows orders type mode by
  // NEED_ORDER). Either way it arrives collapsed: the row budget was spent when the layout was taken.
  // Capping is not part of the basis: "Show N more" changes row counts, it is not a re-sort.
  //
  // What is held is the SECTION order. Row order inside a section is not held: it is the plan's own
  // order (the engine's, most-overdue first) and follows each plan refresh, as it did before.
  //
  // Held in state and reconciled DURING render (NavPrefsContext's derived-state-on-key-change), so no
  // frame paints an unheld order. The reconcile returns the held object itself when nothing changed,
  // which is what stops the render-phase set from looping.
  const [sortTaps, setSortTaps] = useState(0)
  // A tap re-takes, so a layout still waiting to be adopted is dropped: the new order is what is held.
  const onGroupBy = useCallback((value) => { setMode(value); setSortTaps(n => n + 1); setVisit(null) }, [])
  const layoutRows = sortTaps ? enrichedRows : orderingRows
  const pinnedGroups = useMemo(() => {
    const gs = groupRows(layoutRows, mode)
    return gs.map(g => {
      const c = capping ? capStaleRows(g.rows, WATER_STALE_CAP) : { rows: g.rows, hidden: 0 }
      return { ...g, rows: c.rows, hidden: c.hidden, count: g.rows.length }
    })
  }, [layoutRows, mode, capping])
  const basis = mode + ':' + sortTaps + ':' + (enrichById !== NO_ENRICHMENT)
  const [heldLayout, setLayout] = useState(null)
  // A NEW PLAN DAY IS A NEW VISIT. `plan` carries no date of its own (plan_date rides on the envelope
  // and arrives as `planDate`), so a PWA left open on Today overnight takes the morning's plan through
  // a wake refetch into this same mounted list. Without this it kept yesterday's section order, and
  // yesterday's `logged` set, which hides a row by planting+need, hid today's due rows for every
  // planting logged yesterday.
  //
  // Reset IN PLACE, never by remounting. A `key={plan_date}` remount was tried and threw away the
  // in-flight write guards (pendingKeys, writeInFlightRef, bulkInFlightRef, bulkProgress): a Log or a
  // "Log all watering" still in flight when the morning plan landed came back live on the rebuilt
  // list, and a second tap logged it twice. So those are left alone here, along with an open bulk
  // sheet: a write in flight keeps its guard and fades its row, in the new day's list, when it lands.
  // What resets is what a fresh open would give: yesterday's fades, the layout (taken fresh), manual
  // expand/collapse, "Show N more", and the grouping mode.
  //
  // The fades are useCareActions' half of this reset, on the same render and by the same planDate: it
  // keeps a fade whose write is dated the NEW plan day (a log made after midnight on the list still
  // showing yesterday's plan) and a key still pending — see the note there.
  //
  // Same derived-state-during-render shape as the layout: the render that sees the new date queues
  // the resets and skips the reconcile, and the re-render React runs straight after takes it fresh.
  const [day, setDay] = useState(planDate)
  const newDay = day !== planDate
  if (newDay) {
    setDay(planDate)
    setLayout(null)
    setOverrides({})
    setShowCapped(false)
    setMode('location')
    setVisit(null)
  }
  // BUG-TODAYBACKRESORT-001 — adopting the layout held earlier this plan day (`visit`, read at mount).
  // Adopted in the first render whose sections are keyed the way it was saved: the same grouping, and
  // the location names landed or not as they were then. Before the names land the same rows are keyed
  // by project, a different set of sections, so a layout saved after they landed waits one round trip —
  // through the same transient first take every open of Today has always shown — and is adopted in the
  // render that brings them, in place of the take the names used to trigger. From there it is the held
  // layout like any other: a section the refetched plan added is appended, collapsed, and a layout with
  // none of its sections on the list any more is a clean slate. Its open set comes back as it was,
  // manual expands and collapses included; a header tapped in the transient frame keeps its tap, as
  // taps always have across the names landing.
  const restore = (!newDay && visit && !sortTaps && visit.mode === mode
    && visit.enriched === (enrichById !== NO_ENRICHMENT)) ? visit : null
  const layout = restore ? { basis, order: restore.order, expand: new Set(restore.open) } : heldLayout
  if (restore) setVisit(null)
  let held = layout
  if (newDay) held = null
  else if (!layout || layout.basis !== basis) held = takeLayout(pinnedGroups, basis)
  else {
    const seen = new Set(layout.order)
    const added = pinnedGroups.filter(g => !seen.has(g.key)).map(g => g.key)
    if (added.length && added.length === pinnedGroups.length) held = takeLayout(pinnedGroups, basis)
    else if (added.length) held = { ...layout, order: [...layout.order, ...added] }
  }
  if (!newDay && held !== heldLayout) setLayout(held)
  // What a remount adopts: the held order and the sections open on it, written whenever either changes
  // (a take, an appended section, a header tap, By location / By type). Never while a layout is still
  // waiting to be adopted — the transient take must not overwrite it — and never the fades, pendingKeys
  // or an in-flight guard (visitLayout.js). A null layout removes the entry: nothing is held.
  useEffect(() => {
    if (!visitKey || visit) return
    writeVisitLayout(visitKey, heldLayout && {
      mode, enriched: heldLayout.basis.endsWith(':true'), order: heldLayout.order,
      open: heldLayout.order.filter(k => ((k in overrides) ? overrides[k] : heldLayout.expand.has(k))),
    })
  }, [visitKey, visit, heldLayout, overrides, mode])
  const pinnedOrder = (held || NO_LAYOUT).order
  const groups = useMemo(() => {
    const gs = groupRows(enrichedRows, mode, pinnedOrder)
    return gs.map(g => {
      const c = capping ? capStaleRows(g.rows, WATER_STALE_CAP) : { rows: g.rows, hidden: 0 }
      // `bulkRows` is the UNCAPPED set. The cap withholds rows from the display, not from the
      // garden — a section bulk that logged only the visible ones would silently under-report the
      // work Dave says he did, which is the same trade the global bulk already refuses above.
      return { ...g, rows: c.rows, hidden: c.hidden, count: g.rows.length, bulkRows: g.rows }
    })
  }, [enrichedRows, mode, capping, pinnedOrder])
  // Rows ACTUALLY withheld, which is not the same as "the cap is armed" — and the disclosure note
  // below has to key on this one. Before V5-TODAYCAP-001 `capping` was only ever true on a stale day
  // with a long list, so the two were interchangeable and the note keyed on `capping` safely. Now
  // that the cap is always armed, `capping` is true on a five-row day where nothing is withheld, and
  // keying the note on it would announce "Showing the longest-waiting 20 per group" over a list
  // showing all of itself. That is a false statement about the screen, and this note's whole job is
  // that the visible list never silently under-reports the garden — a note that cries wolf on quiet
  // days is how the real disclosure stops being read.
  const hiddenTotal = useMemo(() => groups.reduce((n, g) => n + (g.hidden || 0), 0), [groups])
  const total = rows.length
  const autoKeys = (held || NO_LAYOUT).expand

  const presentTypes = useMemo(() => {
    const seen = []
    for (const need of NEED_ORDER) {
      const et = NEED_EVENT_TYPE[need]
      if (!seen.includes(et) && candidatesFor(et).length) seen.push(et)
    }
    return seen
  }, [candidatesFor])

  // V4-TODAYSECTIONBULK-001 (BD-037) — per-section bulk sets. The SAME predicate as candidatesFor
  // (careNeeded.js candidateKeys, one function since V5-TODAYREDESIGN-001 S1), applied to one group's
  // uncapped rows, so a section button and the global pill can never claim different work. Keyed by
  // NEED_ORDER for a stable button order.
  //
  // Capped at ONE button per section. A group that mixes water and pest work would otherwise grow a
  // row of controls in a header whose whole requirement is to stay tight, and the second type is
  // always the small one — the long tail stays one tap away inside the expanded section. The type
  // shown is the first in NEED_ORDER, which is the time-sensitivity order the list already uses.
  const groupBulkFor = useCallback((group) => {
    const src = Array.isArray(group.bulkRows) ? group.bulkRows : []
    for (const need of NEED_ORDER) {
      const et = NEED_EVENT_TYPE[need]
      const keys = candidateKeys(src, et, { bedWait })
      if (keys.size > 1) return [{ eventType: et, verb: bulkVerb(et), keys }]
    }
    return []
  }, [bedWait])

  const openBulk = useCallback((etype) => {
    setBulkType(etype)
    setBulkChecked(new Set(candidatesFor(etype).map(r => r.key)))
    setBulkProgress(null)
  }, [candidatesFor])

  const isExpanded = (g) => (g.key in overrides) ? overrides[g.key] : autoKeys.has(g.key)

  return (
    <div data-testid="today-care" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div ref={liveRef} role="status" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }} />

      {total === 0 ? (
        <div data-testid="care-empty" style={{ padding: '28px 16px', textAlign: 'center', color: P.light }}>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: P.green, marginBottom: 4 }}>All caught up</div>
          <div style={{ fontSize: '0.82rem', lineHeight: 1.4 }}>Nothing needs care today — enjoy the garden.</div>
          <RainNote plan={plan} center />
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <h2 data-testid="care-heading" style={{ fontSize: '0.95rem', fontWeight: 700, color: P.dark, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Needs care today
            </h2>
            <GroupByControl options={GROUP_OPTS} value={mode} onChange={onGroupBy} />
          </div>

          {/* V4-TODAYVERBIAGE-001 — halved, not deleted, and the half that stayed is the one that
              changes what Dave can conclude from the screen. "Showing the longest-waiting 20 per
              group" is the only thing telling him rows are being WITHHELD; without it the list
              silently under-reports the garden and the group counts stop matching what is under
              them. The dropped clause ("half of these rest on a check N+ days old") was the surface
              explaining its own reasoning — the same class as the bulk-water arithmetic, and the
              staleness is already legible from the rows themselves.
              Prints only while capping is actually in effect: with nothing withheld there is
              nothing to disclose, and the old copy appeared on stale-but-uncapped days too.
              V5-TODAYCAP-001 — keyed on `hiddenTotal`, NOT on `capping`. Those were interchangeable
              while the cap only armed on a stale day; now that it is always armed they are not, and
              `capping` would print this over a list that is showing all of itself. */}
          {hiddenTotal > 0 && (
            <div data-testid="care-cap-note" style={{ fontSize: '0.78rem', color: P.light, lineHeight: 1.4, padding: '0 2px' }}>
              Showing the longest-waiting {WATER_STALE_CAP} per group.
            </div>
          )}

          {presentTypes.length > 0 && (
            <div data-testid="care-bulk-chips" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {presentTypes.map(et => {
                const n = candidatesFor(et).length
                return (
                  <span key={et} style={{ display: 'inline-flex', alignItems: 'stretch', border: '1px solid ' + P.greenLight, background: P.greenPale, borderRadius: 999, overflow: 'hidden' }}>
                    <button type="button" disabled={!!bulkProgress}
                      onClick={() => runBulk(et, new Set(candidatesFor(et).map(r => r.key)))}
                      aria-label={'Log all ' + bulkLabel(et) + ' (' + n + ')'}
                      style={{ minHeight: 36, border: 'none', background: 'none', color: P.green, padding: '6px 12px', fontSize: '0.8rem', fontWeight: 700, cursor: bulkProgress ? 'default' : 'pointer' }}>
                      Log all {bulkLabel(et)} ({n})
                    </button>
                    <button type="button" disabled={!!bulkProgress} onClick={() => openBulk(et)}
                      aria-label={'Choose which ' + bulkLabel(et) + ' to log'}
                      style={{ minHeight: 36, width: 34, border: 'none', borderLeft: '1px solid ' + P.greenLight, background: 'none', color: P.green, fontSize: '0.8rem', fontWeight: 700, cursor: bulkProgress ? 'default' : 'pointer' }}>
                      ⋯
                    </button>
                  </span>
                )
              })}
            </div>
          )}

          {/* V4-TODAYVERBIAGE-001 (BD-035) — the bulk-water denomination note is REMOVED. It was
              added under BUG-CADENCEONEDAY-001 to re-price the list in taps ("One bulk water covers
              111 of these 113") because a row count made a single action read as a hundred jobs.
              That reasoning was sound and the note still did its job; Dave simply does not need it
              told to him any more ("I understand the arithmetic"). Removed rather than shortened —
              a briefer restatement of a thing he has said he already knows is the same noise with
              fewer characters. The count itself is unchanged and still on every bulk pill.
              REVERSIBLE: `bulkWaterNote` and its tests are deleted in the same commit, so restoring
              this means restoring the function, not just this block. */}

          {groups.map(g => (
            <Group key={g.key} group={g} expanded={isExpanded(g)}
              onToggle={() => setOverrides(prev => ({ ...prev, [g.key]: !((g.key in prev) ? prev[g.key] : autoKeys.has(g.key)) }))}
              pendingKeys={pendingKeys} onLog={logRow} onSkip={skipRow} onMoist={moistRow} mode={mode}
              groupBulk={groupBulkFor(g)} onGroupBulk={runBulk} bulkBusy={!!bulkProgress}
              onShowAll={() => setShowCapped(true)} />
          ))}

          <RainNote plan={plan} />
        </>
      )}

      {/* Outside the ternary on purpose: a dormant planting is hidden whether or not anything else
          needs care today, so it must render in the empty state too. */}
      <DormantList plan={plan} />

      {/* Outside the ternary for the same reason, and BETWEEN the two: a drought note carries no
          action (Dormant's Resume stays above it), but it is a passing weather condition rather than
          a standing profile fact, so it leads the permanent "no feed schedule" list below. */}
      <DroughtList plan={plan} />

      {/* Outside the ternary for the same reason, and BELOW Dormant: a dormant row carries an
          action (Resume), a feed-suppressed one carries none, so the actionable list stays higher. */}
      <FeedSuppressedList plan={plan} />

      {/* V4-BACKNAV-001 Slice P (extended) — close-in-place: setBulkType(null) never navigates. */}
      <Sheet armsBack open={!!bulkType} onClose={() => setBulkType(null)} busy={!!bulkProgress} title={bulkType ? 'Log all ' + bulkLabel(bulkType) : ''}>
        {bulkType && (
          <div style={{ padding: '4px 16px 8px' }}>
            <p style={{ fontSize: '0.82rem', color: P.light, margin: '0 0 10px' }}>
              {bulkProgress ? 'Logging ' + bulkProgress.done + ' of ' + bulkProgress.total + '…'
                : 'Only today’s ' + bulkLabel(bulkType) + ' needs — pre-checked.'}
            </p>
            <div role="list" style={{ maxHeight: '46vh', overflowY: 'auto' }}>
              {candidatesFor(bulkType).map(r => {
                const on = bulkChecked.has(r.key)
                return (
                  <label key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid ' + P.border, fontSize: '0.88rem', color: P.dark, cursor: 'pointer' }}>
                    <input type="checkbox" checked={on} disabled={!!bulkProgress}
                      onChange={() => setBulkChecked(prev => { const n = new Set(prev); if (on) n.delete(r.key); else n.add(r.key); return n })} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                    <span style={{ fontSize: '0.74rem', color: P.light }}>{r.reason}</span>
                  </label>
                )
              })}
            </div>
            <button type="button" onClick={() => runBulk(bulkType, bulkChecked)} disabled={!!bulkProgress || bulkChecked.size === 0}
              style={{ marginTop: 12, width: '100%', minHeight: 46, border: 'none', borderRadius: 12, background: bulkChecked.size ? P.green : P.greenPale, color: bulkChecked.size ? P.white : P.green, fontWeight: 700, fontSize: '0.9rem', cursor: bulkChecked.size ? 'pointer' : 'default' }}>
              {bulkProgress ? 'Logging ' + bulkProgress.done + ' of ' + bulkProgress.total + '…' : 'Log all (' + bulkChecked.size + ')'}
            </button>
          </div>
        )}
      </Sheet>
    </div>
  )
}

function bulkLabel(etype) {
  if (etype === 'watering') return 'watering'
  if (etype === 'fertilizing') return 'feeding'
  if (etype === 'observation') return 'checks'
  if (etype === 'brought_inside') return 'protection'
  return 'care'
}

// BD-037 — short imperative for the section header. bulkLabel's noun form ("Log all watering")
// wraps at phone width inside a header that also carries a label and a count.
function bulkVerb(etype) {
  if (etype === 'watering') return 'Water'
  if (etype === 'fertilizing') return 'Feed'
  if (etype === 'brought_inside') return 'Protect'
  return 'Check'
}

// V4-DORMANTRESUME-001 — the dormant plantings the engine emits and nothing has ever rendered.
// Ambient, like RainNote: dormancy is not work, so this is never a card and never an interrupt.
// It exists because dormant is excluded from the care engine AND from every dashboard arm, which
// left an overwintered crop with no surface at all — and no way back, since nothing but a human
// tap clears the status.
//
// Resume writes through the SAME endpoint and payload as the hero StatusPicker
// (PUT /api/plants/:id {status}), so there is one status write path in the app, not two.
// Target is 'vegetative': the canonical growing-but-not-yet-flowering state, which is where garlic,
// asparagus, strawberry and a Christmas cactus all actually restart. Anything more specific the
// gardener can still set on the planting itself.
export function DormantList({ plan }) {
  const { fetch } = useApiFetch()
  const toast = useOptionalToast()
  const [resumed, setResumed] = useState(() => new Set())
  const [pending, setPending] = useState(() => new Set())
  const rows = useMemo(() => dormantRows(plan).filter(r => !resumed.has(r.plantingId)), [plan, resumed])
  if (rows.length === 0) return null

  async function resume(row) {
    if (pending.has(row.plantingId)) return
    setPending(prev => new Set(prev).add(row.plantingId))
    try {
      await fetch('/api/plants/' + row.plantingId, {
        method: 'PUT',
        body: JSON.stringify({ status: 'vegetative' }),
      })
      setResumed(prev => new Set(prev).add(row.plantingId))
      toast?.show?.({ message: row.name + ' is growing again', tone: 'success' })
    } catch {
      // Never optimistic: a failed resume must leave the row where it was, or the planting goes
      // back to being invisible while still dormant — the exact state this list exists to end.
      toast?.show?.({ message: 'Couldn’t resume ' + row.name, tone: 'error' })
    } finally {
      setPending(prev => { const n = new Set(prev); n.delete(row.plantingId); return n })
    }
  }

  return (
    <div data-testid="care-dormant" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 2px' }}>
      <h3 style={{ fontSize: '0.82rem', fontWeight: 700, color: P.dark, margin: 0 }}>Dormant</h3>
      <div style={{ fontSize: '0.78rem', color: P.light, lineHeight: 1.4 }}>
        Resting — no routine care. Resume one when it starts growing again.
      </div>
      {rows.map(row => (
        <div key={row.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8, flexWrap: 'wrap', minHeight: 44 }}>
          {/* Same name treatment as Row above: minWidth:0 + ellipsis is what keeps an unbreakable
              long name from widening the page at 390px rather than shrinking. */}
          <Link to={'/plantings/' + row.plantingId} style={{ fontSize: '0.85rem', color: P.dark,
            textDecoration: 'none', flex: '1 1 auto', minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.name}
          </Link>
          {row.resumable && (
            <button type="button" onClick={() => resume(row)} disabled={pending.has(row.plantingId)}
              aria-label={'Resume ' + row.name}
              style={{ minHeight: 32, padding: '5px 12px', borderRadius: 12, border: '1px solid ' + P.border,
                backgroundColor: P.white, color: P.dark, fontSize: '0.78rem', fontWeight: 600,
                cursor: 'pointer', opacity: pending.has(row.plantingId) ? 0.6 : 1, flex: '0 0 auto' }}>
              Resume
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

// V5-LEGACYEXCEPTIONCARE-001 — the drought signal on plantings held off calendar watering. Ambient,
// like DormantList and RainNote, and that is the design rather than a style choice: "this plant is not
// on calendar watering, and it has been dry" is CONTEXT, not a task. Their profile refuses interval
// watering — that policy is unchanged and this list must never read as work to do, so there is no
// card, no interrupt, no action and no log button on any row.
//
// ALWAYS EXPANDED, unlike FeedSuppressedList, which collapses because nine unchanging rows would cost
// ~400px of Today every single day. This fires only while a space has actually gone 20+ days without a
// deep soak — a handful of rows, during a drought, and hiding the day count behind a tap is most of
// the way back to the signal being invisible, which is the whole defect this closes.
//
// Renders the reason the SELECTOR built (careNeeded.js droughtRows) rather than the engine's `reason`
// string: that field is the suppression clause with the note concatenated onto it, and splitting a
// joined sentence back apart is how the wording drifts. Numbers come off the structured `drought` key.
export function DroughtList({ plan }) {
  const rows = useMemo(() => droughtRows(plan), [plan])
  if (rows.length === 0) return null

  return (
    <div data-testid="care-drought-list" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 2px' }}>
      <h3 style={{ fontSize: '0.82rem', fontWeight: 700, color: P.dark, margin: 0 }}>Dry — no deep soak</h3>
      <div style={{ fontSize: '0.78rem', color: P.light, lineHeight: 1.4 }}>
        These aren’t on calendar watering, and it has been dry. Check the soil at root depth.
      </div>
      {rows.map(row => (
        <div key={row.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8, flexWrap: 'wrap', minHeight: 44 }}>
          {/* Same name treatment as Row/DormantList: minWidth:0 + ellipsis is what keeps an
              unbreakable long name from widening the page at 390px rather than shrinking. */}
          <Link to={'/plantings/' + row.plantingId} style={{ fontSize: '0.85rem', color: P.dark,
            textDecoration: 'none', flex: '1 1 auto', minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.name}
          </Link>
          {/* P.light, never a severity colour: gold means "needed today" everywhere else in this
              component and this is the opposite claim. The text carries the whole signal (SC 1.4.1). */}
          <span style={{ flex: '0 0 auto', fontSize: '0.78rem', color: P.light }}>{row.reason}</span>
        </div>
      ))}
    </div>
  )
}

// BUG-CAREFEEDINHERIT-001 — the plantings whose profile refuses calendar feeding. Ambient, like
// DormantList and RainNote: "never feed this by the calendar" is not work, so this is never a card
// and never an interrupt. It exists because a suppressed planting produces NO Feed card ever, which
// on this screen is indistinguishable from a planting everybody forgot — the engine routes it
// LOUDLY to tasks.feed_suppressed with a rule + reason and, until now, nothing read that.
//
// Renders ONLY for state 'listed'. 'absent' and 'none' both render nothing, for DIFFERENT reasons:
// absent means we do not know whether the gate ran (see feedSuppressedRows), so the surface must
// not speak; none means it ran and found nobody, so there is no planting to name. Neither may ever
// become "0 plantings are on signal-only feeding" without splitting these two apart first.
//
// COLLAPSED BY DEFAULT, via mount/unmount — not <details>, not display:none. Two reasons: nine
// unchanging information-only rows would push ~400px of non-work down Today every single day
// (the V4-TODAYVERBIAGE-001 noise budget), and a CSS/`open`-hidden list is still in the DOM, so a
// test asserting it is hidden false-passes. The summary line IS the toggle: one control, one tap,
// 44px, inline — never a modal, so this needs no DismissRegistry layer (that registry arbitrates
// Escape/Back across modal surfaces; there is no surface here to arbitrate).
export function FeedSuppressedList({ plan }) {
  const { state, rows } = useMemo(() => feedSuppressedRows(plan), [plan])
  const [open, setOpen] = useState(false)
  if (state !== FEED_SUPPRESSED_LISTED) return null
  const n = rows.length
  const label = (open ? 'Hide the ' : 'Show the ') + n + ' planting' + (n > 1 ? 's' : '') + ' with no feed schedule'

  return (
    <div data-testid="care-feed-suppressed" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 2px' }}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label={label}
        style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, width: '100%',
          padding: '2px', border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer' }}>
        {/* care.feed is the same glyph the fertilizing care chip carries, tinted P.green rather than
            the gold needTier gives a due feed row — gold in this app means "needed today", and this
            is the opposite claim. Colour is additive: the sentence says it too (SC 1.4.1). */}
        <Icon name="care.feed" size={18} decorative style={{ color: P.green, flex: '0 0 auto' }} />
        <span style={{ flex: 1, minWidth: 0, fontSize: '0.78rem', color: P.light, lineHeight: 1.4 }}>
          No feed schedule for {n} planting{n > 1 ? 's' : ''} — fed on plant signals, never by the calendar.
        </span>
        <span aria-hidden="true" style={{ flex: '0 0 auto', fontSize: '0.78rem', fontWeight: 700, color: P.green }}>
          {open ? 'Hide' : 'Show'}
        </span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 2px 4px' }}>
          {/* Chips, not full-width rows: nine names cost ~3 wrapped lines at 390px instead of nine
              44px rows, and each is still its own tap target INTO the planting record. Same
              minWidth:0 + ellipsis treatment as Row/DormantList for an unbreakable long name. */}
          {rows.map(row => (
            <Link key={row.key} to={'/plantings/' + row.plantingId}
              aria-label={row.name + ' — no feed schedule'}
              style={{ display: 'inline-flex', alignItems: 'center', minHeight: 36, maxWidth: '100%',
                padding: '6px 12px', borderRadius: 999, border: '1px solid ' + P.border,
                backgroundColor: P.white, color: P.dark, fontSize: '0.8rem', textDecoration: 'none',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row.name}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

// Ambient rain-credit note (DRG-WATERCREDIT-001) — quiet, never a card/interrupt.
export function RainNote({ plan, center }) {
  const n = Array.isArray(plan && plan.rain_skipped) ? plan.rain_skipped.length : 0
  if (!n) return null
  return (
    <div data-testid="care-rain-note" style={{ fontSize: '0.78rem', color: P.light, padding: '4px 6px', textAlign: center ? 'center' : 'left' }}>
      Rain handled watering for {n} planting{n > 1 ? 's' : ''} — recent rain counts.
    </div>
  )
}

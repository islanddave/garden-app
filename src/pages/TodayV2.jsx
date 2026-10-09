import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useDailyPlan } from '../hooks/useDailyPlan.js'
import { useTodaySections } from '../hooks/useTodaySections.js'
import { useTodayVisit } from '../hooks/useTodayVisit.js'
import { useLiveRain } from '../hooks/useLiveRain.js'
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion.js'
import { usePageScrollYield } from '../hooks/usePageScrollManager.js'
import { usePrefs } from '../context/PrefsContext.jsx'
import { useAuthOptional } from '../context/AuthContext.jsx'
import AsyncRegion from '../components/forms/AsyncRegion.jsx'
import TodaySection from '../components/today/v2/TodaySection.jsx'
import NeedsCare from '../components/today/v2/NeedsCare.jsx'
import { useNeedsCare } from '../components/today/v2/useNeedsCare.js'
import GlanceCard from '../components/today/v2/GlanceCard.jsx'
import JumpBar, { JUMP_BAR_HEIGHT_PX } from '../components/today/v2/JumpBar.jsx'
import ProtectTonight from '../components/today/v2/ProtectTonight.jsx'
import { useProtect } from '../components/today/v2/useProtect.js'
import HeadsUp from '../components/today/v2/HeadsUp.jsx'
import { useHeadsUp } from '../components/today/v2/useHeadsUp.js'
import { handledSummary } from '../lib/todayV2/protect.js'
import { openAtStart } from '../lib/todayV2/triggers.js'
import { CHIPS, taskCounts, liveChips, shownChips } from '../lib/todayV2/chips.js'
import { staleMarker } from '../lib/todayV2/verdict.js'
import { agreedTonightLow, agreeCallout } from '../lib/tonightLow.js'
import { currentLows } from '../lib/frostAlertLine.js'
import { isFromCache } from '../lib/api.js'
import { buildCareNeeded } from '../lib/careNeeded.js'
import { todayLocalISO } from '../lib/dateLocal.js'
import { P, TOP_CHROME_HEIGHT_PX, BOTTOM_NAV_HEIGHT_PX } from '../lib/constants.js'
import { T } from '../components/forms/formStyles.js'
import Icon from '../components/Icon.jsx'
// S6: Harvest, Put-Up, Resting's rows, the household sections, the Sow link row.
import HarvestWatchBand from '../components/HarvestWatchBand.jsx'
import ComposeHarvestBand from '../components/ComposeHarvestBand.jsx'
import PutUpUseSoonBand from '../components/PutUpUseSoonBand.jsx'
import CultivationLead from '../components/today/CultivationLead.jsx'
import { DormantList } from '../components/today/CareNeeded.jsx'
import HouseholdSection, { householdKey } from '../components/today/v2/HouseholdSection.jsx'
import { useTodayBands } from '../components/today/v2/useTodayBands.js'
import { useHandednessSync } from '../hooks/useHandedness.js'
import { useMembers } from '../hooks/useMembers.js'
import { readShowOthers, memberFirstName } from '../lib/householdView.js'
import { SOW_DATED_LINES_FROZEN } from '../lib/featureFlags.js'

// TodayV2 — the redesigned Today (V5-TODAYREDESIGN-001; plan-v2 §1, §2.1–2.2, §4–§6). Behind the per-device
// switch (TodayRoute), off by default: this page is DARK until Dave flips the default (S8b).
//
// S2 IS THE SKELETON: the Seeds frame, the title row (1.3rem green "Today" + Expand/Collapse all), the date,
// the loading / error / no-plan states, one page-level status region, and the SECTIONS — in their fixed
// order, as flat bands (TodaySection), open or closed from the three state layers:
//   Layer 1 remembered (useTodaySections: the localStorage mirror; the server column is S7's) — written ONLY
//           by an explicit header tap;
//   Layer 2 the visit (useTodayVisit: Expand/Collapse all, and later chip jumps and triggers) — never saved;
//   Layer 3 triggers (S5: triggers.js openAtStart, ONE evaluation at the ready point) — only Protect tonight,
//           Heads-up and Needs care ever open by themselves.
// The bands S2 can build from the plan alone are here: Needs care (count = water + feed + check, §2.4) and
// Resting (count, names, its explainer). Each later slice fills its own: glance card + jump bar (S3), the
// Needs care body (S4), Protect tonight + Heads-up (S5), Harvest / Put-Up / Resting rows / household (S6).
//
// S3 — the GLANCE CARD paints as soon as the plan is in (it needs nothing else); its open/closed is Layer 1
// key 'glance' (a tap is remembered, nothing ever opens it by itself). The JUMP BAR paints at the ready point
// with the chips live there, HELD for the visit (order.chips); it is the page's one sticky layer. A chip tap
// opens its section as a visit overlay, scrolls its header under the bar and focuses it; Water / Feed / Check
// also leave S4's filter row a pre-select intent (useTodayVisit `setFilter`). While this page is mounted the
// document scrolls with the sticky layers subtracted (html scroll-padding).
//
// THE READY POINT (§6.4): the plan has settled (a plan, no plan, or an error) and Layer 1 can be read — prefs
// have loaded, OR this device has a mirror, OR 300 ms have passed. Sections paint THERE, all at once, from a
// snapshot taken there; nothing sits below them that could be pushed down, and a prefs answer that lands
// later waits for the next visit. `data-today-ready` marks it for gate:today-shape:v2.
//
// Region anchors (data-testid) are gate:today-shape:v2's contract (tests/harness/_todaymeasure/
// today-v2-contract.mjs): renaming one is a contract change made in the same commit.
export const SECTION_ORDER = ['protect', 'headsup', 'care', 'harvest', 'putup', 'resting']
const CARE_NEEDS = new Set(['water_due', 'no_history', 'fertilize', 'pest', 'overwintering'])
const PREFS_WAIT_MS = 300
// §6.2's bottom allowance: one toast's height above BottomNav, so a focused control is never under either.
const TOAST_ALLOWANCE_PX = 64

// The tapped chip, when cut at the strip's edge, slides fully into view. The STRIP scrolls (strip.scrollTo) —
// never chip.scrollIntoView, which would scroll the page as well (§6.2).
function revealChip(strip, chip, behavior) {
  if (!strip || !chip || typeof strip.scrollTo !== 'function') return
  const s = strip.getBoundingClientRect()
  const c = chip.getBoundingClientRect()
  const dx = c.left < s.left ? c.left - s.left : c.right > s.right ? c.right - s.right : 0
  if (dx) strip.scrollTo({ left: strip.scrollLeft + dx, behavior })
}

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00')
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

// First three names, then "+N" (plan-v2 §1.1 "Blackberry, Kousa Dogwood, Christmas Cactus +6").
export function namesSummary(items, shown = 3) {
  const names = items.map((it) => (it && (it.name || it.crop)) || null).filter(Boolean)
  if (!names.length) return null
  const head = names.slice(0, shown).join(', ')
  return names.length > shown ? `${head} +${names.length - shown}` : head
}

// §2.4: the Needs care header count is Water + Feed + Check over ACTIVE rows — the plan's rows minus the
// shared skip set (V2 logs nothing until S4, whose store then removes logged rows too). Cold rows belong to
// Protect tonight alone.
export function activeCareRows(plan, skipped) {
  return buildCareNeeded(plan).filter((r) => CARE_NEEDS.has(r.need) && !skipped.has(r.key))
}

export default function TodayV2() {
  const { user, profile } = useAuthOptional()
  const userId = user?.id ?? null
  const { prefs, prefsLoaded, refreshPrefs } = usePrefs()
  // Always the household question (§2.9): the server answers [] with no one else, so no toggle reloads.
  const { data, loading, error, reload, seedPending } = useDailyPlan({ includeHousehold: true, seed: userId || undefined })
  // Review 4160.2 IMPORTANT-2 (integration 2): a Back paints the last good plan (the seed) at once, read BEFORE the
  // page was left — a watering logged meanwhile on a planting's own page is still due in it. Until that remount's
  // revalidation settles, every write control on the page (Needs care, Protect tonight, the household sections) is
  // inert: aria-disabled, and its handler posts nothing. Undo stays live (it only deletes this visit's own writes).
  const writesHeld = !!seedPending
  const planDate = data?.plan_date ?? null
  const plan = data?.has_plan ? (data.plan ?? null) : null
  const layer1 = useTodaySections({ userId, prefs })
  // §3: a plan served from the offline cache, or not dated today, is stale — it opens nothing.
  const stale = !!data && (isFromCache(data) || data.plan_date !== todayLocalISO())
  // S4: Needs care's state lives here, above its section (the header, the trigger and the visit's held order
  // are taken at the ready point; the body is unmounted while closed). §2.4: the active rows = the plan's
  // care rows minus logged minus skipped.
  const needs = useNeedsCare({ plan, planDate, userId, stale })
  const care = needs.rows
  // S5: Protect tonight's state lives here too (header, chip count, trigger and held order are taken at the ready
  // point). Its rows are every cold row — the household's too when this person has the household view on (SF6);
  // Needs care never lists one. Needs care's rows weight its spot order, so both sections list spots alike.
  const protect = useProtect({ plan, planDate, userId, stale, householdPlans: data?.household_plans, careRows: needs.allEnriched })
  // S5: Heads-up (storage windows) reads /api/plants and the device date — plan-independent, never stale.
  const headsup = useHeadsUp()
  const statusRef = useRef(null)
  const announce = useCallback((msg) => { if (statusRef.current) statusRef.current.textContent = msg }, [])
  const resting = useMemo(() => (Array.isArray(plan?.dormant) ? plan.dormant.filter(Boolean) : []), [plan])

  // ── S6: the plan-INDEPENDENT sections — Harvest and From your Put-Up (plan-v2 §1.0 rows 4–5; they render with no
  // plan too, §1.4) — the household sections (row 7) and the Sow link row (row 8). The bands are fetched HERE and
  // handed to their sections' bodies, which are unmounted while closed (useTodayBands). No sow lines are asked for
  // while the 2027 sowing freeze holds (V5-SOWFREEZELINES-001).
  const bands = useTodayBands({ viewerId: profile?.id ?? null, sowLines: !SOW_DATED_LINES_FROZEN })
  // Hoisted from HarvestWatchBand (plan §8 S6): the band's once-per-session handedness adopt ran because the band
  // was always mounted on Today; here the Harvest body is unmounted while closed, so the page runs it.
  useHandednessSync(needs.getToken)
  // SF6: another member's section only when THIS device has the household view on — V1's switch, read through
  // the one reader both pages share (lib/householdView.js), and only for a member with care rows today. The plan
  // read always asks for the household (§2.9, above); this decides what is SHOWN. Names as V1 names them.
  const [showOthers] = useState(readShowOthers)
  const { members } = useMembers()
  const household = useMemo(() => {
    if (!showOthers || !Array.isArray(data?.household_plans)) return []
    const others = (members || []).filter((m) => m && m.id && m.id !== profile?.id)
    return data.household_plans.filter((hp) => hp && hp.user_id && hp.plan)
      .map((hp) => ({ key: householdKey(hp.user_id), userId: hp.user_id, plan: hp.plan, name: memberFirstName(others, hp.user_id) }))
  }, [showOthers, data, members, profile?.id])
  const skippedNow = needs.actions.skipped
  const hhPresent = useMemo(() => household.filter((h) => activeCareRows(h.plan, skippedNow).length > 0).map((h) => h.key), [household, skippedNow])

  const present = useMemo(() => [
    ...SECTION_ORDER.filter((k) => (k === 'protect' && protect.count > 0) || (k === 'headsup' && headsup.count > 0) || (k === 'care' && care.length > 0) || (k === 'resting' && resting.length > 0) || (k === 'harvest' && bands.harvest.present) || (k === 'putup' && bands.putup.present)),
    ...hhPresent,
  ], [protect.count, headsup.count, care.length, resting.length, bands.harvest.present, bands.putup.present, hhPresent])

  // ── the glance card's weather: computed exactly as V1's Today.jsx computes it, so the two pages cannot
  // disagree — the live rain overlay (display only), the one low per night (V5-FROSTTWOMODELS-001), the frost
  // line's current lows (V5-TODAYFROSTWARMEDADVISORY-001) and the engine cue re-worded at that low.
  const { liveHydrology, refreshedAt } = useLiveRain(plan?.weather_coords ?? plan?.coords)
  const agreed = useMemo(() => agreedTonightLow(plan), [plan])
  const current = useMemo(() => currentLows(plan), [plan])
  const cueCallout = useMemo(() => agreeCallout(plan?.weather?.callout, agreed), [plan, agreed])
  // The glance card's stale marker (verdict.js): the conditions of `stale` above, worded for the card (null
  // when the plan is today's).
  const staleMark = plan ? staleMarker({ planDate, generatedAt: data?.generated_at ?? null, fromCache: isFromCache(data), today: todayLocalISO() }) : null

  // ── the jump chips (§2.4, §2.7): Water / Feed / Check from the same active rows as the Needs care count.
  const counts = useMemo(() => ({ ...taskCounts(care), protect: protect.count }), [care, protect.count])
  const live = useMemo(() => liveChips(present, counts), [present, counts])

  // ── the ready point ───────────────────────────────────────────────────────────────────────────────────────
  const settled = !loading
  const [prefsWaitOver, setPrefsWaitOver] = useState(false)
  useEffect(() => {
    if (!settled || prefsWaitOver) return undefined
    const t = setTimeout(() => setPrefsWaitOver(true), PREFS_WAIT_MS)
    return () => clearTimeout(t)
  }, [settled, prefsWaitOver])
  // A new plan day while mounted is a new visit (§2.2): re-read prefs first and start it from the answer
  // (bounded by the same 300 ms), so the day's first visit sees the other device's choices.
  const [day, setDay] = useState({ seen: planDate, awaiting: false })
  let awaitingPrefs = day.awaiting
  if (planDate && planDate !== day.seen) {
    awaitingPrefs = day.seen != null
    setDay({ seen: planDate, awaiting: awaitingPrefs })
  }
  useEffect(() => {
    if (!day.awaiting) return undefined
    let on = true
    const done = () => { if (on) setDay((d) => ({ ...d, awaiting: false })) }
    const t = setTimeout(done, PREFS_WAIT_MS)
    Promise.resolve().then(() => refreshPrefs()).catch(() => null).finally(done)
    return () => { on = false; clearTimeout(t) }
  }, [day.awaiting, refreshPrefs])
  // S4 adds /api/plants + /api/locations settled (ok or failed) to the ready point (§6.4): the spots, groups
  // and the small-pot trigger read them, and a snapshot taken before they land would be keyed differently.
  // S5: Protect reads the same two requests (+ the roster when a household row needs a name) — with no plan too,
  // since the household's cold rows can make Protect exist on their own.
  // protect.settled covers Heads-up's one request (/api/plants) as well.
  // S6 adds the bands' first answers (ok or failed), capped by the same 300 ms window: a remembered-open Harvest
  // is then open at the visit's start and nothing below Needs care moves when they land; a band slower than that
  // is inserted closed in its slot when it arrives (§2.9).
  const ready = settled && !awaitingPrefs && (prefsLoaded || layer1.mirrorExists || prefsWaitOver) && (!plan || needs.settled) && protect.settled && (bands.settled || prefsWaitOver)

  const { record, isOpen, tap, overlayAll, update, setFilter } = useTodayVisit({
    userId, planDate, ready,
    start: () => {
      // §3 + MF1 — ONE evaluation (triggers.js openAtStart): Protect tonight (frost / hard freeze / a chill
      // planting's first night), Heads-up (a storage window's first day, its last two days), Needs care (never /
      // hot / small) each open by themselves unless a close made today already covers their trigger; the
      // descriptors are kept so a close now records the ack.
      const opened = openAtStart({ present, planDate, resolve: layer1.resolve, triggers: { protect: protect.trigger, headsup: headsup.trigger, care: needs.trigger } })
      return {
        order: { sections: present, chips: live },
        layer1: {
          ...Object.fromEntries(present.map((k) => [k, layer1.resolve(k)?.open === true])),
          glance: layer1.resolve('glance')?.open === true,
        },
        overlay: opened.overlay,
        triggers: opened.triggers,
        care: needs.snapshot(),
        protect: protect.snapshot(),
      }
    },
  })
  const shown = record ? SECTION_ORDER.filter((k) => record.order.sections.includes(k) || present.includes(k)) : []
  // S6: the household sections, after Resting (held in the visit's order like every section; a member's first
  // appearance mid-visit takes the next slot). Expand / Collapse all move them with the rest.
  const hhShown = record ? [...new Set([...record.order.sections, ...present])].filter((k) => k.startsWith('hh-')) : []
  const allShown = [...shown, ...hhShown]
  const anyOpen = allShown.some(isOpen)

  // The glance paints before the visit starts: until then Layer 1 answers directly (a tap lands there first,
  // so the visit's snapshot at the ready point carries it).
  const glanceOpen = record ? isOpen('glance') : layer1.resolve('glance')?.open === true
  const toggleGlance = useCallback(() => {
    const next = !glanceOpen
    layer1.remember('glance', { open: next, at: planDate || todayLocalISO() })
    tap('glance', next)
  }, [glanceOpen, layer1, planDate, tap])

  // The bar exists for the visit only when ≥ 2 chips did at the ready point (§2.7); a chip that goes live later
  // takes its slot, a held one that empties reads "· done".
  const heldChips = record?.order?.chips || []
  const barShown = ready && !!record && heldChips.length >= 2
  const chips = barShown ? shownChips(heldChips, live) : []

  // A chip tap (§2.7, §5.5): the page-scroll manager stands down (usePageScrollYield), the target opens as a
  // visit overlay (never remembered), a task chip leaves S4 its pre-select intent, and — after the commit that
  // mounts the target's body — the header scrolls under the bar (instant under reduced motion, smooth
  // otherwise) and takes focus without a second scroll.
  const frameRef = useRef(null)
  const barRef = useRef(null)
  const reduced = usePrefersReducedMotion()
  const reducedRef = useRef(reduced)
  reducedRef.current = reduced
  const yieldScroll = usePageScrollYield()
  const [landing, setLanding] = useState(null)
  const jump = useCallback((key, chipEl) => {
    const c = CHIPS[key]
    if (!c) return
    yieldScroll()
    overlayAll([c.section], 'open')
    if (c.task) setFilter(c.section, { tasks: [c.task] })
    revealChip(barRef.current, chipEl, reducedRef.current ? 'instant' : 'smooth')
    setLanding((l) => ({ section: c.section, seq: (l ? l.seq : 0) + 1 }))
  }, [yieldScroll, overlayAll, setFilter])
  useLayoutEffect(() => {
    if (!landing) return
    const sec = frameRef.current?.querySelector(`[data-section="${landing.section}"]`)
    if (!sec) return
    if (typeof sec.scrollIntoView === 'function') sec.scrollIntoView({ block: 'start', behavior: reducedRef.current ? 'instant' : 'smooth' })
    const header = sec.querySelector('[aria-expanded]')
    if (header && typeof header.focus === 'function') header.focus({ preventScroll: true })
  }, [landing])

  // While this page is mounted the document scrolls with its sticky layers subtracted (§6.2): a focus move,
  // TalkBack's own scroll or a jump lands BELOW TopChrome and the bar and ABOVE BottomNav plus one toast. The
  // 8px landing gap is each section's scroll-margin-top (TodaySection), so a jump lands a header 8px under the
  // bar. Cleared on unmount — no other page inherits it.
  useLayoutEffect(() => {
    const s = document.documentElement.style
    const before = [s.scrollPaddingTop, s.scrollPaddingBottom]
    s.scrollPaddingTop = `calc(${TOP_CHROME_HEIGHT_PX}px + env(safe-area-inset-top)${barShown ? ` + ${JUMP_BAR_HEIGHT_PX}px` : ''})`
    s.scrollPaddingBottom = `calc(var(--bottom-nav-height, ${BOTTOM_NAV_HEIGHT_PX}px) + env(safe-area-inset-bottom) + ${TOAST_ALLOWANCE_PX}px)`
    return () => { s.scrollPaddingTop = before[0]; s.scrollPaddingBottom = before[1] }
  }, [barShown])

  // An explicit tap: the visit's state for the section AND Layer 1. A close made while a trigger holds the
  // section open records that trigger as a date-scoped ack (MF1); an open drops any ack.
  const toggle = useCallback((key) => {
    const next = !isOpen(key)
    const trigger = record?.triggers?.[key]
    const ack = !next && record?.overlay?.[key] === 'open' && trigger ? trigger : null
    const at = planDate || todayLocalISO()
    layer1.remember(key, ack ? { open: next, at, ack } : { open: next, at })
    tap(key, next)
  }, [isOpen, record, planDate, layer1, tap])

  // SF8: reasons + spots, never counts; the urgency cue (severity.med + the imperative) only when a trigger
  // opened the section this visit. Emptied mid-visit (§2.5, S4g): "Needs care · all caught up" over what was
  // logged today and what rain took (useNeedsCare caughtUp).
  const resumedSet = useMemo(() => new Set(record?.resting?.resumed || []), [record])
  const markResumed = useCallback((id) => update((r) => ({ ...r, resting: { resumed: [...new Set([...(r.resting?.resumed || []), id])] } })), [update])
  const restingLeft = resting.filter((it) => !resumedSet.has(it.id))
  const careUrgent = !!record?.triggers?.care && record?.overlay?.care === 'open'
  // S5: the urgency cue (severity.med) only when a trigger opened Protect this visit; the words are the night's
  // ("Before dark · low 42°F · Lemon Verbena, Sweet Basil +3"). Emptied mid-visit: what this visit did.
  const protectUrgent = !!record?.triggers?.protect && record?.overlay?.protect === 'open'
  const headsupUrgent = !!record?.triggers?.headsup && record?.overlay?.headsup === 'open'
  const SECTIONS = {
    protect: {
      title: 'Protect tonight',
      count: protect.count || null,
      summary: protect.count
        ? (protectUrgent ? <><Icon name="severity.med" size={16} decorative style={{ verticalAlign: '-0.2em', marginRight: 4 }} />{protect.summary}</> : protect.summary)
        : handledSummary(record?.protect),
      body: <ProtectTonight protect={protect} record={record} update={update} announce={announce} writesHeld={writesHeld} />,
    },
    headsup: {
      title: 'Heads-up',
      count: headsup.count || null,
      summary: headsupUrgent && headsup.summary
        ? <><Icon name="severity.med" size={16} decorative style={{ verticalAlign: '-0.2em', marginRight: 4 }} />{headsup.summary}</>
        : headsup.summary,
      body: <HeadsUp headsup={headsup} record={record} update={update} />,
    },
    care: {
      title: care.length ? 'Needs care' : needs.caughtUp.title,
      count: care.length || null,
      summary: care.length
        ? (careUrgent && needs.summary ? <><Icon name="severity.med" size={16} decorative style={{ verticalAlign: '-0.2em', marginRight: 4 }} />{needs.summary}</> : needs.summary)
        : needs.caughtUp.summary,
      body: <NeedsCare care={needs} record={record} update={update} announce={announce} planDate={planDate} userId={userId} filterIntent={record?.filter?.care} writesHeld={writesHeld} />,
    },
    // S6: the explainer (S2), then DormantList's rows, bare. Resume is never optimistic (DormantList); the plants it
    // resumed are held on the visit record, so a close and re-open (closed = unmounted) keeps them off the list,
    // and the count and names follow.
    resting: {
      title: 'Resting',
      count: restingLeft.length || null,
      summary: namesSummary(restingLeft),
      body: (
        <div style={stackBody}>
          <p style={quietLine}>No routine care while resting — Resume one when it starts growing.</p>
          <DormantList plan={plan} bare resumed={resumedSet} onResumed={markResumed} />
        </div>
      ),
    },
    // S6 (plan-v2 §1.1 row 7, §4): the compose band's picks line and the watch band's own selection in the header —
    // names, never a count (Reward UX, §10 item 4) — and both bands' rows, bare, behind the tap.
    harvest: {
      title: 'Harvest',
      count: null,
      summary: bands.harvest.summary,
      body: (
        <div style={stackBody}>
          <ComposeHarvestBand data={bands.compose} bare />
          <HarvestWatchBand data={bands.watch} bare />
        </div>
      ),
    },
    // S6 (§1.5): the use-soon slice's jars in the header; the band's rows and its Open Put-Up door, bare.
    putup: {
      title: 'From your Put-Up',
      count: null,
      summary: bands.putup.summary,
      body: <PutUpUseSoonBand data={bands.soon} bare />,
    },
  }

  return (
    <div
      ref={frameRef}
      data-testid="today-page"
      data-today-version="2"
      data-today-ready={ready && record ? 'true' : undefined}
      data-prefs-loaded={prefsLoaded ? 'true' : 'false'}
      style={frameStyle}
    >
      <div style={titleRow}>
        <h1 data-testid="today-title" style={titleStyle}>Today</h1>
        {ready && allShown.length > 0 && (
          <button type="button" data-testid="today-expand-all" onClick={() => overlayAll(allShown, anyOpen ? 'closed' : 'open')} style={textButton}>
            {anyOpen ? 'Collapse all' : 'Expand all'}
          </button>
        )}
      </div>
      <p data-testid="today-date" style={dateStyle}>{formatDate(planDate) || 'Your garden, at a glance'}</p>
      {/* The page's ONE live region (§5.6); the sections announce through it from S4 on. */}
      <div ref={statusRef} role="status" aria-live="polite" data-testid="today-status" style={srOnly} />

      {/* Mounted only while it has something to say: its <section> is a flex item, and an empty one would
          still take a gap. A refresh never shows here — stale rows beat blank rows (useDailyPlan). */}
      {!data && (loading || error) && (
        <AsyncRegion loading={loading} error={error} onRetry={reload} errorTitle="Couldn’t load today’s plan" />
      )}
      {data && !data.has_plan && (
        <p data-testid="today-noplan-card" style={noPlanStyle}>Today’s plan hasn’t arrived yet — it’s built overnight.</p>
      )}
      {/* The glance card needs only the plan (its weather comes from it): no plan, no card (§1.4). */}
      {plan && plan.weather && (
        <GlanceCard
          plan={plan} generatedAt={data?.generated_at ?? null} planDate={planDate}
          liveHydrology={liveHydrology} refreshedAt={refreshedAt} agreed={agreed} current={current} cueCallout={cueCallout}
          stale={staleMark} open={glanceOpen} onToggle={toggleGlance}
          care={needs} record={record} update={update} announce={announce} writesHeld={writesHeld}
        />
      )}

      {ready && record && (
        <>
          {/* The one sticky layer: a direct child of this frame, so it pins across every section below it. */}
          {barShown && <JumpBar ref={barRef} chips={chips} counts={counts} onJump={jump} />}
          {plan && care.length === 0 && !record.order.sections.includes('care') && (
            <p data-testid="care-empty" style={quietLine}>Needs care: all caught up — nothing due today.</p>
          )}
          {shown.map((key) => {
            const s = SECTIONS[key]
            return (
              <TodaySection
                key={key}
                sectionKey={key}
                title={s.title}
                count={s.count}
                summary={s.summary}
                open={isOpen(key)}
                onToggle={() => toggle(key)}
                style={key === 'care' ? careGap : undefined}
                headerTestId={key === 'care' ? 'care-heading' : undefined}
              >
                {s.body}
              </TodaySection>
            )
          })}
          {/* S6: one section per other member with care rows today (SF6: only while this device has the household
              view on), after Resting — closed by default, never opened by a trigger. `today-household` anchors them. */}
          {hhShown.length > 0 && (
            <div data-testid="today-household" style={stackSections}>
              {hhShown.map((key) => {
                const h = household.find((x) => x.key === key)
                return h ? (
                  <HouseholdSection
                    key={key} sectionKey={key} name={h.name} plan={h.plan} planDate={planDate} viewerId={userId} stale={stale}
                    record={record} update={update} announce={announce} open={isOpen(key)} onToggle={() => toggle(key)} writesHeld={writesHeld}
                  />
                ) : null
              })}
            </div>
          )}
          {/* The Sow link row (BD-067): a link, not a section, and LAST — the durable door to Seeds › Sow now. It is
              CultivationLead, bare (S6); its dated lines stay unasked-for and hidden while the 2027 sowing freeze
              holds (featureFlags SOW_DATED_LINES_FROZEN, V5-SOWFREEZELINES-001). */}
          <CultivationLead data={bands.sow} bare />
        </>
      )}
    </div>
  )
}

// ── styles (plan-v2 §4; tokens P / T) ──────────────────────────────────────────────────────────────────────
// The Seeds frame (Seeds.jsx), one flex column: sections are spaced by the gap, never by their own margins.
const frameStyle = { maxWidth: 720, margin: '0 auto', padding: '12px 16px 90px', display: 'flex', flexDirection: 'column', gap: T.space.sm }
const titleRow = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: T.space.sm, minHeight: T.tapMinHeight }
const titleStyle = { margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }
const textButton = {
  minHeight: T.tapMinHeight, padding: `0 ${T.space.xs}px`, background: 'none', border: 'none', cursor: 'pointer',
  color: P.green, fontWeight: 600, fontSize: T.type.sm, fontFamily: 'inherit',
}
const dateStyle = { margin: 0, fontSize: T.type.sm, fontWeight: 400, color: P.mid }
const noPlanStyle = { margin: 0, fontSize: T.type.base, color: P.dark }
const quietLine = { margin: 0, fontSize: T.type.sm, color: P.mid }
// T.space.md before Needs care: the frame's gap gives T.space.sm, the band asks for the difference.
const careGap = { marginTop: T.space.md - T.space.sm }
// S6: a section body holding more than one block (Resting's explainer + rows; Harvest's two bands), and the
// household sections' stack — spaced like the frame, since children never set outer margins.
const stackBody = { display: 'flex', flexDirection: 'column', gap: T.space.xs }
const stackSections = { display: 'flex', flexDirection: 'column', gap: T.space.sm }
const srOnly = { position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }

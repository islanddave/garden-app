import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router-dom'
import { useDailyPlan } from '../hooks/useDailyPlan.js'
import { useTodaySections } from '../hooks/useTodaySections.js'
import { useTodayVisit } from '../hooks/useTodayVisit.js'
import { usePrefs } from '../context/PrefsContext.jsx'
import { useAuthOptional } from '../context/AuthContext.jsx'
import AsyncRegion from '../components/forms/AsyncRegion.jsx'
import TodaySection from '../components/today/v2/TodaySection.jsx'
import { buildCareNeeded } from '../lib/careNeeded.js'
import { subscribeSkipped, skippedSnapshot } from '../components/today/careStore.js'
import { todayLocalISO } from '../lib/dateLocal.js'
import { seedsHref } from '../lib/seedsRoutes.js'
import { P } from '../lib/constants.js'
import { T } from '../components/forms/formStyles.js'
import Icon from '../components/Icon.jsx'

// TodayV2 — the redesigned Today (V5-TODAYREDESIGN-001; plan-v2 §1, §2.1–2.2, §4–§6). Behind the per-device
// switch (TodayRoute), off by default: this page is DARK until Dave flips the default (S8b).
//
// S2 IS THE SKELETON: the Seeds frame, the title row (1.3rem green "Today" + Expand/Collapse all), the date,
// the loading / error / no-plan states, one page-level status region, and the SECTIONS — in their fixed
// order, as flat bands (TodaySection), open or closed from the three state layers:
//   Layer 1 remembered (useTodaySections: the localStorage mirror; the server column is S7's) — written ONLY
//           by an explicit header tap;
//   Layer 2 the visit (useTodayVisit: Expand/Collapse all, and later chip jumps and triggers) — never saved;
//   Layer 3 triggers (S5) — none yet, so at S2 nothing opens by itself.
// The bands S2 can build from the plan alone are here: Needs care (count = water + feed + check, §2.4) and
// Resting (count, names, its explainer). Each later slice fills its own: glance card + jump bar (S3), the
// Needs care body (S4), Protect tonight + Heads-up (S5), Harvest / Put-Up / Resting rows / household (S6).
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
  const { user } = useAuthOptional()
  const userId = user?.id ?? null
  const { prefs, prefsLoaded, refreshPrefs } = usePrefs()
  // Always the household question (§2.9): the server answers [] with no one else, so no toggle reloads.
  const { data, loading, error, reload } = useDailyPlan({ includeHousehold: true, seed: userId || undefined })
  const planDate = data?.plan_date ?? null
  const plan = data?.has_plan ? (data.plan ?? null) : null
  const skipped = useSyncExternalStore(subscribeSkipped, skippedSnapshot, skippedSnapshot)
  const layer1 = useTodaySections({ userId, prefs })

  const care = useMemo(() => activeCareRows(plan, skipped), [plan, skipped])
  const resting = useMemo(() => (Array.isArray(plan?.dormant) ? plan.dormant.filter(Boolean) : []), [plan])
  const present = useMemo(() => SECTION_ORDER.filter((k) => (k === 'care' && care.length > 0) || (k === 'resting' && resting.length > 0)), [care.length, resting.length])

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
  const ready = settled && !awaitingPrefs && (prefsLoaded || layer1.mirrorExists || prefsWaitOver)

  const { record, isOpen, tap, overlayAll } = useTodayVisit({
    userId, planDate, ready,
    start: () => ({
      order: { sections: present },
      layer1: Object.fromEntries(present.map((k) => [k, layer1.resolve(k)?.open === true])),
      overlay: {},
      triggers: {},
    }),
  })
  const shown = record ? SECTION_ORDER.filter((k) => record.order.sections.includes(k) || present.includes(k)) : []
  const anyOpen = shown.some(isOpen)

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

  const SECTIONS = {
    care: {
      title: 'Needs care',
      count: care.length || null,
      summary: care.length ? null : 'All caught up.',
      body: <p data-testid="today-v2-pending" style={quietLine}>The spots and plants for this list arrive in a later preview.</p>,
    },
    resting: {
      title: 'Resting',
      count: resting.length || null,
      summary: namesSummary(resting),
      body: <p style={quietLine}>No routine care while resting — Resume one when it starts growing.</p>,
    },
  }

  return (
    <div
      data-testid="today-page"
      data-today-version="2"
      data-today-ready={ready && record ? 'true' : undefined}
      data-prefs-loaded={prefsLoaded ? 'true' : 'false'}
      style={frameStyle}
    >
      <div style={titleRow}>
        <h1 data-testid="today-title" style={titleStyle}>Today</h1>
        {ready && shown.length > 0 && (
          <button type="button" data-testid="today-expand-all" onClick={() => overlayAll(shown, anyOpen ? 'closed' : 'open')} style={textButton}>
            {anyOpen ? 'Collapse all' : 'Expand all'}
          </button>
        )}
      </div>
      <p data-testid="today-date" style={dateStyle}>{formatDate(planDate) || 'Your garden, at a glance'}</p>
      {/* The page's ONE live region (§5.6); the sections announce through it from S4 on. */}
      <div role="status" aria-live="polite" data-testid="today-status" style={srOnly} />

      {/* Mounted only while it has something to say: its <section> is a flex item, and an empty one would
          still take a gap. A refresh never shows here — stale rows beat blank rows (useDailyPlan). */}
      {!data && (loading || error) && (
        <AsyncRegion loading={loading} error={error} onRetry={reload} errorTitle="Couldn’t load today’s plan" />
      )}
      {data && !data.has_plan && (
        <p data-testid="today-noplan-card" style={noPlanStyle}>Today’s plan hasn’t arrived yet — it’s built overnight.</p>
      )}

      {ready && record && (
        <>
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
              >
                {s.body}
              </TodaySection>
            )
          })}
          {/* The Sow link row (BD-067): a link, not a section, and LAST — the durable door to Seeds › Sow now.
              Dated sow lines stay hidden while the 2027 sowing freeze holds (V5-SOWFREEZELINES-001, S6). */}
          <Link to={seedsHref('sow')} data-testid="cultivation-lead" style={sowLink}>
            <Icon name="lifecycle.sprout" size={20} decorative style={{ flexShrink: 0 }} />
            <span>All sow windows ›</span>
          </Link>
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
// BUG-LINKICONBLUE-001: an explicit ink on any <Link> holding an <Icon>, or a mono glyph renders link-blue.
const sowLink = {
  display: 'flex', alignItems: 'center', gap: T.space.sm, minHeight: T.tapMinHeight, textDecoration: 'none',
  color: P.green, fontWeight: 600, fontSize: T.type.sm,
}
const srOnly = { position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }

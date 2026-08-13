import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { useDailyPlan } from '../hooks/useDailyPlan.js'
import WeatherWidget, { asOfLabel } from '../components/today/WeatherWidget.jsx'
import { useLiveRain } from '../hooks/useLiveRain.js'
import CareNeeded from '../components/today/CareNeeded.jsx'
import CultivationLead from '../components/today/CultivationLead.jsx'
import PutUpUseSoonBand from '../components/PutUpUseSoonBand.jsx'
import HarvestReadyBand from '../components/HarvestReadyBand.jsx'
import HarvestWatchBand from '../components/HarvestWatchBand.jsx'
import ComposeHarvestBand from '../components/ComposeHarvestBand.jsx'
import { P } from '../lib/constants.js'
import Icon from '../components/Icon.jsx'
import { useMembers } from '../hooks/useMembers.js'
import { useAuthOptional } from '../context/AuthContext.jsx'

// Today — the daily care surface (DRG-TODAY-002). Reads the per-user plan the overnight Daily Plan engine
// (DRG-TODAY-001) persisted for today: an icon-first weather widget up top, a substrate/feeding note, and
// collapsed-by-default task buckets that deep-link to each planting. Operational surface (Reward-UX V101
// §7): ambient, no celebration/streak/badge/interrupt. Engine ships dormant, so until it runs there is no
// row for today and the surface shows an honest "your plan is on its way" state (Jen-invisible: no internals).

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00')
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

export default function Today() {
  // V4-ASSIGNLENS-001 — opt-in "also show the rest of the household's care" on Today. Default is
  // strictly per-user (mine only). Only when the toggle is on (and there IS another caretaker) do we
  // ask the read model to widen (?include=household). Care logging on others' items uses the same
  // household-scoped POST /api/events, so no per-item auth change is needed.
  const { profile } = useAuthOptional()
  const { members } = useMembers()
  const others = (members || []).filter(m => m && m.id && m.id !== profile?.id)
  const canShowOthers = others.length > 0
  const [showOthers, setShowOthers] = useState(() => { try { return localStorage.getItem('garden.today.showOthers') === '1' } catch { return false } })
  const toggleOthers = () => setShowOthers(v => { const nv = !v; try { localStorage.setItem('garden.today.showOthers', nv ? '1' : '0') } catch { /* ignore */ } return nv })
  const nameFor = (sub) => { const m = others.find(o => o.id === sub); const n = (m?.display_name || '').trim(); return n ? n.split(/\s+/)[0] : 'Someone else' }

  const { data, loading, error } = useDailyPlan({ includeHousehold: showOthers && canShowOthers })
  const plan = data?.plan ?? null
  const hasPlan = !!data?.has_plan
  const householdPlans = Array.isArray(data?.household_plans) ? data.household_plans : []
  // DRG-WXROLL-001 — refresh the displayed rain figure live (Open-Meteo) using the plan's resolved coords;
  // display-only, the watering recommendation stays the nightly plan. No coords/offline -> nightly snapshot.
  const { liveHydrology, refreshedAt } = useLiveRain(plan?.weather_coords ?? plan?.coords)

  return (
    <div style={{ padding: 16, paddingBottom: 32, maxWidth: 640, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: P.dark, marginBottom: 2 }}>Today</h1>
        <Link to="/capture" data-testid="snap-entry-today" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: P.green, color: P.white, border: 'none', borderRadius: 20, padding: '7px 14px', fontSize: '0.85rem', fontWeight: 600, textDecoration: 'none' }}><Icon name="media.camera" size={15} decorative surface="inverse" /><span>Snap</span></Link>
      </div>
      <p style={{ fontSize: '0.84rem', color: P.light, marginTop: 0, marginBottom: 16 }}>
        {formatDate(data?.plan_date) || 'Your garden, at a glance'}
      </p>

      {/* PANEL Q1 (harvest-panel-decisions-20260812.md) — the cultivation lead line, the demoted
          third region of Today: one or two imperative lines at the very top, no heading, no count,
          renders nothing when empty. Reads the sow engine's own window_closing output; invents no
          cue. Deliberately ABOVE the plan/weather block and both harvest bands. */}
      <CultivationLead />

      {loading && <div style={{ padding: 20, color: P.light, textAlign: 'center' }}>Loading&hellip;</div>}
      {error && <div style={{ padding: 20, color: '#b94a3a', textAlign: 'center' }}>{error}</div>}

      {!loading && !error && !hasPlan && (
        <div style={{
          padding: '28px 18px', textAlign: 'center', color: P.mid,
          background: P.white, border: `1px solid ${P.border}`, borderRadius: 12,
        }}>
          <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'center' }}><Icon name="care.sun" size={30} decorative /></div>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: P.dark, marginBottom: 6 }}>
            Your first daily plan is on its way.
          </div>
          <div style={{ fontSize: '0.85rem', color: P.light, lineHeight: 1.5 }}>
            Plans are put together overnight from your weather and what you&rsquo;ve logged. Check back in the morning &mdash; your watering, feeding and protection list for the day will show up right here.
          </div>
        </div>
      )}

      {!loading && !error && hasPlan && plan && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* BUG-TODAYWATER-001 honesty guard — the widget's headline and <CareNeeded>'s list are two
              independently-thresholded verdicts on the same plan, and they demonstrably disagreed
              (08-03, 08-08). Handing the widget the SAME list it sits above is what lets it stop
              claiming "All set" over a non-empty one. Length, not contents: no new coupling. */}
          {plan.weather && (
            <WeatherWidget weather={plan.weather} hydrology={plan.hydrology} generatedAt={data?.generated_at} planDate={data?.plan_date} liveHydrology={liveHydrology} refreshedAt={refreshedAt} waterDueCount={Array.isArray(plan.water_due) ? plan.water_due.length : 0} />
          )}

          {/* V4-TODAYHOLD-001 — Today is an ACTION surface: show the substrate/feeding note only
              when it is actionable. `substrate.on_hold` is true exactly when there are zero feed
              recommendations (the long "Feeding on HOLD — fresh MG mix is feeding all N plantings…"
              explainer that otherwise reappears every single day with nothing to do). Suppress that
              empty-state noise; keep the actionable "N planting(s) past the feed window" reminder
              (on_hold=false). The DrG "Today's reasoning" panel still surfaces the full note as a
              WHY — that surface explains, this one asks for action. */}
          {plan.substrate?.msg && !plan.substrate?.on_hold && (
            <div style={{
              fontSize: '0.82rem', color: P.mid, lineHeight: 1.45,
              background: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: 10, padding: '10px 12px',
            }}>
              <Icon name="lifecycle.sprout" size={15} decorative style={{ marginRight: 6, verticalAlign: '-0.15em' }} />{plan.substrate.msg}
            </div>
          )}

          {/* V4-TODAYBASIS-001 — the care list is computed from the OVERNIGHT batch, but it sits
              directly under WeatherWidget's "Updated {liveAt} · live" stamp, so that live stamp
              reads as covering the whole screen. It doesn't: a 6pm watering call here was decided
              from last night's snapshot. Stamping the basis time on the actionable content is the
              honest presentation V3-WXFRESH-001 established for the weather card, applied to the
              part whose staleness actually has consequences. Reuses asOfLabel for one vocabulary. */}
          {asOfLabel(data?.generated_at) && (
            <div style={{ fontSize: '0.75rem', color: P.light, marginBottom: -6 }}>
              Plan from overnight &middot; as of {asOfLabel(data.generated_at)}
            </div>
          )}

          <CareNeeded plan={plan} />
        </div>
      )}

      {/* V4-HARVESTCENTER-001 (L10) — "use soon" from your put-up stores. Ambient, neutral, self-
          fetching; renders nothing when empty, so it costs no space on a fresh account. */}
      <PutUpUseSoonBand />

      {/* V4-HARVESTSURF-001 — cadence-evidence "ready to pick" nudge. Same ambient, self-fetching,
          hidden-when-empty posture as the band above; never fires without a prior harvest. */}
      <HarvestReadyBand />

      {/* V4-HARVSURFACE-001 Slice 1 — Section 2 of the two-section harvest surface: the "worth
          checking" watch list. Deliberately BELOW the ready band: that one is an action surface
          (imperative, go/no-go now), this one is a plan surface (declarative, "what changed since
          I last looked"). Design §4 — the mood and weight difference is what stops these rows from
          being read as tasks, which is what would turn the screen back into an inventory. Same
          ambient posture as its neighbours: self-fetching, error swallowed, hidden when empty. */}
      <HarvestWatchBand />

      {/* V4-COMPOSEPOST-001 — compose tonight's harvest post from what was just logged. Same ambient
          posture again: self-fetching, error swallowed, renders nothing unless there is a batch from
          the last 18 hours. Deliberately AFTER the ready-to-pick band — that one asks you to go pick
          something; this one is what you reach for once you already have. */}
      <ComposeHarvestBand />

      {/* V4-ASSIGNLENS-001 — the rest of the household's care (opt-in, ambient, subordinate). Works
          whether or not the current user has their own plan today. Reuses CareNeeded so logging on
          another caretaker's planting goes through the identical one-tap events path. */}
      {!loading && !error && canShowOthers && (
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            onClick={toggleOthers}
            aria-pressed={showOthers}
            style={{
              background: 'none', border: `1px solid ${P.border}`, borderRadius: 20,
              padding: '6px 14px', fontSize: '0.82rem', fontWeight: 600, color: P.mid, cursor: 'pointer',
            }}
          >
            {showOthers ? 'Hide' : 'Show'} the rest of the household’s care
          </button>
          {showOthers && householdPlans.map(hp => (
            <details key={hp.user_id} open style={{ marginTop: 12, borderTop: `1px solid ${P.border}`, paddingTop: 12 }}>
              <summary style={{ cursor: 'pointer', fontSize: '0.95rem', fontWeight: 700, color: P.mid, listStyle: 'revert', padding: '2px 0' }}>
                {nameFor(hp.user_id)}’s care today
              </summary>
              <div style={{ marginTop: 10 }}>
                <CareNeeded plan={hp.plan} />
              </div>
            </details>
          ))}
          {showOthers && householdPlans.length === 0 && (
            <p style={{ fontSize: '0.82rem', color: P.light, marginTop: 10 }}>No one else has care needs today.</p>
          )}
        </div>
      )}
    </div>
  )
}

import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { useDailyPlan } from '../hooks/useDailyPlan.js'
import WeatherWidget from '../components/today/WeatherWidget.jsx'
import { useLiveRain } from '../hooks/useLiveRain.js'
import CareNeeded from '../components/today/CareNeeded.jsx'
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
          {plan.weather && (
            <WeatherWidget weather={plan.weather} hydrology={plan.hydrology} generatedAt={data?.generated_at} planDate={data?.plan_date} liveHydrology={liveHydrology} refreshedAt={refreshedAt} />
          )}

          {plan.substrate?.msg && (
            <div style={{
              fontSize: '0.82rem', color: P.mid, lineHeight: 1.45,
              background: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: 10, padding: '10px 12px',
            }}>
              <Icon name="lifecycle.sprout" size={15} decorative style={{ marginRight: 6, verticalAlign: '-0.15em' }} />{plan.substrate.msg}
            </div>
          )}

          <CareNeeded plan={plan} />
        </div>
      )}

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

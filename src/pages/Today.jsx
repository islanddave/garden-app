import React from 'react'
import { useDailyPlan } from '../hooks/useDailyPlan.js'
import WeatherWidget from '../components/today/WeatherWidget.jsx'
import { useLiveRain } from '../hooks/useLiveRain.js'
import PlanBuckets from '../components/today/PlanBuckets.jsx'
import { P } from '../lib/constants.js'

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
  const { data, loading, error } = useDailyPlan()
  const plan = data?.plan ?? null
  const hasPlan = !!data?.has_plan
  // DRG-WXROLL-001 — refresh the displayed rain figure live (Open-Meteo) using the plan's resolved coords;
  // display-only, the watering recommendation stays the nightly plan. No coords/offline -> nightly snapshot.
  const { liveHydrology, refreshedAt } = useLiveRain(plan?.weather_coords ?? plan?.coords)

  return (
    <div style={{ padding: 16, paddingBottom: 32, maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: P.dark, marginBottom: 2 }}>Today</h1>
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
          <div style={{ fontSize: '1.6rem', marginBottom: 8 }}>🌅</div>
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
              <span aria-hidden="true" style={{ marginRight: 6 }}>🌱</span>{plan.substrate.msg}
            </div>
          )}

          <PlanBuckets plan={plan} />
        </div>
      )}
    </div>
  )
}

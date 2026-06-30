// drgReasoning.js — Slice 8 (V4-THEME-001) Doctor Gardener "Why today looks like this".
// Pure, anti-fabrication: derives a read-only rationale STRICTLY from the daily-plan data the
// engine already produced (counts / substrate / weather / hydrology / rain_skipped). It invents
// NOTHING — every line is gated on real data, and there are no tappable tasks here (Today owns the
// actionable list; DrG only explains). Locking this in a unit test guarantees DrG never narrates
// data it doesn't have. data = useDailyPlan().data = { has_plan, plan, ... }.

const NEED_CLAUSE = [
  ['water_due', n => n + (n === 1 ? ' to water' : ' to water')],
  ['no_history', n => n + ' never watered'],
  ['fertilize', n => n + ' to feed'],
  ['pest', n => n + ' to scout'],
  ['cold', n => n + ' cold-sensitive'],
]

// Returns { state: 'noplan' | 'steady' | 'plan', lines: string[] }.
export function buildReasoningLines(data) {
  if (!data || !data.has_plan || !data.plan) return { state: 'noplan', lines: [] }
  const plan = data.plan
  const lines = []

  const w = plan.weather
  if (w && (typeof w.highToday === 'number' || typeof w.tonightLow === 'number')) {
    let s = 'High ' + w.highToday + '°, low ' + w.tonightLow + '° tonight'
    if (w.hot) s += ' — hot day'
    lines.push(s)
  }

  const c = plan.counts
  if (c && typeof c.plantings === 'number') {
    const parts = []
    for (const [k, fmt] of NEED_CLAUSE) {
      const n = c[k]
      if (typeof n === 'number' && n > 0) parts.push(fmt(n))
    }
    if (parts.length) lines.push(c.plantings + ' plantings — ' + parts.join(', '))
  }

  if (plan.substrate && plan.substrate.msg) lines.push(plan.substrate.msg)

  const rs = Array.isArray(plan.rain_skipped) ? plan.rain_skipped.length : 0
  if (rs > 0) lines.push('Skipped watering ' + rs + ' planting' + (rs > 1 ? 's' : '') + ' — recent rain counted.')

  if (lines.length === 0) return { state: 'steady', lines: [] }
  return { state: 'plan', lines }
}

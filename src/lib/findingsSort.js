// Findings ordering — care-engine-spec C7: order by trend + decay_state, NEVER by urgency_level
// (urgency is emitted but DE-PRIVILEGED — it must not influence ordering or prominence).
// Most actionable first: worsening before steady before improving; within a trend, fresher first.
export const TREND_RANK = { worsening: 0, steady: 1, improving: 2 }
export const DECAY_RANK = { fresh: 0, decaying: 1, stale_unverified: 2, dormant: 3, resolved: 4 }

export function sortFindings(findings) {
  return [...(findings ?? [])].sort((a, b) => {
    const t = (TREND_RANK[a?.trend] ?? 9) - (TREND_RANK[b?.trend] ?? 9)
    if (t !== 0) return t
    const d = (DECAY_RANK[a?.decay_state] ?? 9) - (DECAY_RANK[b?.decay_state] ?? 9)
    if (d !== 0) return d
    return String(a?.finding_id ?? '').localeCompare(String(b?.finding_id ?? ''))
  })
}

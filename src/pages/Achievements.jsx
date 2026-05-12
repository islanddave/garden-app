// Achievements page — V1.2a-1 Session 4
// Three sections:
//   - Earned (sorted by earned_at DESC)
//   - Available (locked, visible, sorted by sort_order)
//   - Secret count chip (no detail, just "🤫 N hidden" if > 0)
//
// Future: tap-on-earned → detail modal; tap-on-locked → richer hint modal.
// V1.2a-1: static cards with inline hints.

import { useAchievements } from '../hooks/useAchievements.js'
import { P } from '../lib/constants.js'

function formatEarnedAt(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return '' }
}

function lockedHint(triggerType, triggerValue) {
  const tv = triggerValue ?? {}
  switch (triggerType) {
    case 'event_count':         return `Log ${tv.count ?? '?'} events`
    case 'event_type_count':    return `Log ${tv.count ?? '?'} ${tv.type ?? 'events'}`
    case 'streak':              return `Reach a ${tv.streak ?? tv.count ?? '?'}-day streak`
    case 'level':               return `Reach level ${tv.level ?? '?'}`
    case 'location_count':      return `Log events in ${tv.count ?? '?'} locations`
    case 'time_of_day':         return `Log during a specific time of day`
    case 'absence_return':      return `Come back after a long break`
    case 'multi_per_day':       return `Log ${tv.count ?? 2}+ events in one day`
    case 'photo_count':         return `Attach ${tv.count ?? '?'} photos`
    case 'project_event_count': return `Reach ${tv.count ?? '?'} events on one project`
    case 'seasonal':            return `Log during a specific season`
    default: return 'Keep logging events to unlock'
  }
}

function AchievementCard({ a, earned }) {
  return (
    <div style={{
      display: 'flex', gap: 12, padding: 12, borderRadius: 10,
      backgroundColor: earned ? P.greenPale : P.white,
      border: `1px solid ${P.border}`,
      opacity: earned ? 1 : 0.6,
    }}>
      <div style={{ fontSize: '1.8rem', lineHeight: 1, flexShrink: 0 }}>{a.emoji || '🏅'}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, color: P.dark, fontSize: '0.95rem' }}>{a.name}</div>
        <div style={{ fontSize: '0.82rem', color: P.light, marginTop: 2 }}>{a.description}</div>
        {earned ? (
          <div style={{ fontSize: '0.72rem', color: P.green, marginTop: 4, fontWeight: 600 }}>
            +{a.xp_reward} XP · earned {formatEarnedAt(a.earned_at)}
          </div>
        ) : (
          <div style={{ fontSize: '0.72rem', color: P.light, marginTop: 4 }}>
            {lockedHint(a.trigger_type, a.trigger_value)} · +{a.xp_reward} XP
          </div>
        )}
      </div>
    </div>
  )
}

export default function Achievements() {
  const { data, loading, error } = useAchievements()

  if (loading) return <div style={{ padding: 20, color: P.light, textAlign: 'center' }}>Loading…</div>
  if (error) return <div style={{ padding: 20, color: '#b94a3a', textAlign: 'center' }}>{error}</div>
  if (!data) return null

  const earned = data.earned ?? []
  const locked = data.locked ?? []
  const totalEarned = data.total_earned ?? 0
  const totalVisible = data.total_visible ?? 0
  const secretCount = data.secret_locked_count ?? 0

  return (
    <div style={{ padding: 16, paddingBottom: 32, maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: P.dark, marginBottom: 6 }}>
        Achievements
      </h1>
      <div style={{ fontSize: '0.85rem', color: P.light, marginBottom: 20 }}>
        {totalEarned} of {totalVisible} earned{secretCount > 0 ? ` · 🤫 ${secretCount} hidden` : ''}
      </div>

      {earned.length === 0 && locked.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: P.light, fontSize: '0.92rem' }}>
          Log your first event to start earning achievements 🌱
        </div>
      ) : (
        <>
          {earned.length > 0 && (
            <>
              <h2 style={{ fontSize: '1rem', fontWeight: 700, color: P.dark, marginBottom: 8 }}>
                Earned ({earned.length})
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
                {earned.map(a => <AchievementCard key={a.id} a={a} earned />)}
              </div>
            </>
          )}

          {locked.length > 0 && (
            <>
              <h2 style={{ fontSize: '1rem', fontWeight: 700, color: P.dark, marginBottom: 8 }}>
                Available ({locked.length})
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {locked.map(a => <AchievementCard key={a.id} a={a} earned={false} />)}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

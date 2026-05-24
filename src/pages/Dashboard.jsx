import React, { useEffect, useState, useCallback, useRef } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { useZone } from '../context/ZoneContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { P, PROJECT_STATUSES } from '../lib/constants.js'
import { getStatusColors } from '../lib/status.js'
import { hapticDouble, hapticTriple } from '../lib/haptic.js'
import ErrorBoundary from '../components/ErrorBoundary.jsx'
import HarvestReadyTile from '../components/HarvestReadyTile.jsx'
import HeadsUpTile from '../components/HeadsUpTile.jsx'
import NotifyButton from '../components/NotifyButton.jsx'

// First-name extraction (I10-greeting fix, L-063, 2026-05-18). profile.display_name may be a full
// name like "Dave Nichols"; we render greetings with first name only.
function firstName(displayName) {
  if (!displayName || typeof displayName !== 'string') return null
  const token = displayName.trim().split(/\s+/)[0]
  return token || null
}

// DASH-ORDER-HARVEST-GATE (2026-05-18, V1.2a-3 Increment C / PR-C2):
// HarvestReadyTile renders only when at least one active project is in fruiting or flowering.
const HARVEST_GATE_STATUSES = new Set(['fruiting', 'flowering'])

function DashboardFallback({ error, retry } = {}) {
  const ts = new Date().toLocaleString()
  const code = Math.random().toString(36).slice(2, 8)
  return (
    <div role="alert" style={{
      padding: '20px 16px',
      margin: '12px 0',
      backgroundColor: '#fde8e0',
      border: '1px solid #b7532a',
      borderRadius: 10,
      color: '#7a2a10',
      fontSize: '0.88rem',
    }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Couldn't load dashboard at {ts}.</div>
      <div style={{ fontSize: '0.78rem', color: '#7a5c3c', marginBottom: 10 }}>Code: {code}</div>
      <button
        type="button"
        onClick={retry}
        style={{
          minHeight: 44, minWidth: 44,
          padding: '8px 16px',
          background: 'transparent',
          border: '1px solid #b7532a',
          borderRadius: 6,
          color: '#7a2a10',
          fontWeight: 600,
          cursor: 'pointer',
        }}>Try again</button>
    </div>
  )
}

const LOGGABLE_STATUSES = PROJECT_STATUSES.filter(s => s !== 'harvesting')

// V1.2a-1 §C-V1.2a-1-D: streak milestones for next-milestone modal display
const STREAK_MILESTONES = [3, 7, 14, 30, 100]

// Stale threshold for Tile 1 "Give attention to" — surface only projects engaged within last 30 days.
// Never-touched and very-stale projects defer to V1.2a-2 "Inactive projects" surface.
const STALE_MS = 30 * 86400000

function getProjectActivity(p) {
  const candidates = [
    { at: p.last_watered_at,    type: 'watering' },
    { at: p.last_observed_at,   type: 'observation' },
    { at: p.last_fertilized_at, type: 'fertilizing' },
    { at: p.last_pruned_at,     type: 'pruning' },
    { at: p.last_harvested_at,  type: 'harvest' },
  ].filter(c => c.at).sort((a, b) => b.at.localeCompare(a.at))
  if (!candidates.length) return null
  return { last_event_at: candidates[0].at, last_event_type: candidates[0].type }
}

// V002 §C-V1.2a-1-D Tile 2 severity tier: green=on-time, gold=due today,
// terra=1-2 days over, terra-bold=3+ days over OR indoor_seedling >24h over.
// Tile 2 query only returns next_water_at < NOW(), so daysOver > 0 always.
function severityTier(nextWaterAtIso, locationType) {
  const daysOver = (Date.now() - new Date(nextWaterAtIso).getTime()) / 86400000
  if (locationType === 'indoor_seedling' && daysOver >= 1) return 'terra-bold'
  if (daysOver >= 3) return 'terra-bold'
  if (daysOver >= 1) return 'terra'
  return 'gold'
}

const SEVERITY_STYLES = {
  green:        { bg: P.greenPale, border: P.greenLight, text: P.green },
  gold:         { bg: P.warn,      border: P.warnBorder, text: '#7a5c00' },
  terra:        { bg: '#fde8e0',   border: P.terra,      text: P.terra },
  'terra-bold': { bg: '#fcd7c4',   border: P.terra,      text: '#7a2a10' },
}

export default function Dashboard() {
  const { profile }       = useAuth()
  const { fetch: apiFetch } = useApiFetch()
  const { activeZone }    = useZone()
  const location          = useLocation()
  const navigate          = useNavigate()

  const [projects,      setProjects]      = useState([])
  const [nextAttention, setNextAttention] = useState(null)
  const [entityMap,     setEntityMap]     = useState({})
  const [recentEvents,  setRecentEvents]  = useState([])
  const [userStats,     setUserStats]     = useState({ current_streak: 0, longest_streak: 0, last_active_date: null, total_events: 0, xp: 0 })
  const [waterDue,      setWaterDue]      = useState([])
  const [inactiveCount, setInactiveCount] = useState(0)
  const [harvestReady,  setHarvestReady]  = useState(undefined)
  const [headsUp,       setHeadsUp]       = useState(undefined)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState(null)
  const [streakModalOpen, setStreakModalOpen] = useState(false)
  const [achievementQueue, setAchievementQueue] = useState([])
  const [undoState, setUndoState] = useState(null) // { eventId, projectName, expiresAt }

  // Pulse trigger keyed on streak value — increments cause animation re-fire.
  const prevStreakRef = useRef(null)
  const [streakPulse, setStreakPulse] = useState(0)

  const loadDashboard = useCallback(async (isMounted) => {
    try {
      const dashData = await apiFetch('/api/dashboard')
      if (!isMounted) return

      const activeProjects = (dashData.active_projects ?? []).filter(p =>
        LOGGABLE_STATUSES.includes(p.status)
      )
      setProjects(activeProjects)
      setRecentEvents(dashData.recent_events ?? [])
      setUserStats(dashData.user_stats ?? { current_streak: 0, longest_streak: 0, last_active_date: null, total_events: 0, xp: 0 })
      setWaterDue(dashData.water_due ?? [])
      setInactiveCount(dashData.inactive_projects_count ?? 0)
      setHarvestReady(dashData.harvest_ready ?? [])
      setHeadsUp(dashData.heads_up ?? [])

      const memMap = {}
      activeProjects.forEach(p => {
        const activity = getProjectActivity(p)
        if (activity) memMap[p.id] = activity
      })
      setEntityMap(memMap)

      // V002: surface recently-engaged-but-stale first (last_event_at within 30d, oldest ASC).
      // Never-touched and very-stale (>30d) defer to V1.2a-2 "Inactive projects" surface.
      const now = Date.now()
      const stale = activeProjects
        .filter(p => memMap[p.id] && (now - new Date(memMap[p.id].last_event_at).getTime()) < STALE_MS)
        .sort((a, b) => memMap[a.id].last_event_at.localeCompare(memMap[b.id].last_event_at))

      // Define "needs attention" = last_event_at >= 24h ago. Anything fresher = "caught up".
      const oldest = stale.find(p => (now - new Date(memMap[p.id].last_event_at).getTime()) >= 86400000)

      if (oldest) {
        setNextAttention({
          id: oldest.id,
          name: oldest.name,
          last_event_at: memMap[oldest.id].last_event_at,
        })
      } else {
        setNextAttention(null) // triggers "All caught up 🌱" zero state if projects.length > 0
      }
    } catch (err) {
      if (isMounted) setError(err.message)
    } finally {
      if (isMounted) setLoading(false)
    }
  }, [apiFetch])

  useEffect(() => {
    let isMounted = true
    loadDashboard(isMounted)
    return () => { isMounted = false }
  }, [loadDashboard])

  // Pulse animation trigger: when streak value increases, re-fire pulse via key change.
  useEffect(() => {
    const cur = userStats.current_streak ?? 0
    if (prevStreakRef.current !== null && cur > prevStreakRef.current) {
      setStreakPulse(p => p + 1)
      hapticDouble()
    }
    prevStreakRef.current = cur
  }, [userStats.current_streak])

  // Handle log-event return from EventNew: extract payload, refresh data, queue achievement toasts + undo.
  useEffect(() => {
    const logged = location.state?.logged
    if (!logged) return

    // Refresh dashboard data (cache invalidation pattern — replace React Query in V1.3+).
    let isMounted = true
    loadDashboard(isMounted)

    // Queue achievement toasts.
    if (logged.newly_earned_achievements?.length) {
      setAchievementQueue(q => [...q, ...logged.newly_earned_achievements])
      hapticTriple()
    }

    // Show undo toast for 5 seconds.
    if (logged.id) {
      setUndoState({
        eventId: logged.id,
        projectName: logged.project_name ?? 'event',
        expiresAt: Date.now() + 5000,
      })
    }

    // Clear navigation state so refresh on tab-revisit doesn't re-fire.
    navigate(location.pathname, { replace: true, state: null })

    return () => { isMounted = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, loadDashboard, navigate])

  // Handle issue-resolve return from EventDetail: refresh data, queue achievement
  // toasts. No undo toast — that's only for the logged-event flow.
  useEffect(() => {
    if (!location.state?.refreshDashboard) return

    let isMounted = true
    loadDashboard(isMounted)

    const earned = location.state?.newly_earned_achievements
    if (earned?.length) {
      setAchievementQueue(q => [...q, ...earned])
      hapticTriple()
    }

    // Clear navigation state so refresh on tab-revisit doesn't re-fire.
    navigate(location.pathname, { replace: true, state: null })

    return () => { isMounted = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, loadDashboard, navigate])

  // Auto-dismiss undo toast.
  useEffect(() => {
    if (!undoState) return
    const remaining = undoState.expiresAt - Date.now()
    if (remaining <= 0) { setUndoState(null); return }
    const t = setTimeout(() => setUndoState(null), remaining)
    return () => clearTimeout(t)
  }, [undoState])

  // Sequential achievement toasts (2s each). Split into two effects so the auto-dismiss
  // timer isn't cancelled by the promotion effect's cleanup when currentToast changes.
  const [currentToast, setCurrentToast] = useState(null)
  // Promotion: when no toast is showing and queue has items, promote the next one.
  useEffect(() => {
    if (currentToast || achievementQueue.length === 0) return
    setCurrentToast(achievementQueue[0])
    setAchievementQueue(q => q.slice(1))
  }, [achievementQueue, currentToast])
  // Auto-dismiss: when a toast is showing, clear it 2s later.
  useEffect(() => {
    if (!currentToast) return
    const t = setTimeout(() => setCurrentToast(null), 2000)
    return () => clearTimeout(t)
  }, [currentToast])

  async function handleUndo() {
    if (!undoState) return
    const evId = undoState.eventId
    setUndoState(null)
    try {
      await apiFetch(`/api/events/${evId}`, { method: 'DELETE' })
      // Reload — note Lambda 2.1.x doesn't reverse user_stats/xp/achievements on DELETE;
      // streak/XP recovery is a V1.2a-2 reconciliation cron concern.
      loadDashboard(true)
    } catch (err) {
      console.warn('undo failed', err)
    }
  }

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  })

  if (loading) return (
    <div style={{ padding: '48px 20px', textAlign: 'center', color: P.mid }}>
      Loading…
    </div>
  )

  if (error) return (
    <div style={{ padding: '48px 20px', textAlign: 'center', color: P.terra }}>
      Error loading dashboard: {error}
    </div>
  )

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream, position: 'relative' }}>
      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '32px 20px' }}>

        {/* Header — Welcome + Streak counter top-right.
             I10-greeting (2026-05-18): first-name only per CLAUDE.md L-063.
             DASH-LOC-REDUNDANT (2026-05-18): removed the "WHERE ARE YOU?" zone link below.
             The TopBar zone pill is the single source of truth for zone display + change. */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 20 }}>
          <div>
            <h1 style={{ color: P.green, fontSize: '1.4rem', fontWeight: 700, margin: '0 0 4px' }}>
              Welcome back, {firstName(profile?.display_name) ?? 'Dave'} 🌿
            </h1>
            <p style={{ color: P.light, fontSize: '0.875rem', margin: 0 }}>{today}</p>
          </div>
          <StreakCounter
            streak={userStats.current_streak ?? 0}
            pulseKey={streakPulse}
            onTap={() => setStreakModalOpen(true)}
          />
        </div>

        {/* Dashboard tile region — wrapped in ErrorBoundary so tile crashes don't blank the page.
             DASH-ORDER-HARVEST-GATE (2026-05-18, V1.2a-3 Increment C / PR-C2):
               (1) Give Attention To, (2) Water Me, (3) Harvest Ready [conditional on
               ≥1 fruiting/flowering project; else hidden entirely — not shown empty],
               (4) Heads Up. HarvestReady slots between Water Me and Heads Up when active. */}
        <ErrorBoundary scope="dashboard" fallback={<DashboardFallback />}>
          {/* Tile 1: Give attention to — non-hide zero state */}
          <GiveAttentionTile
            nextAttention={nextAttention}
            hasProjects={projects.length > 0}
          />

          {/* Tile 2: Water me — non-hide primer + multi-overdue list */}
          <WaterMeTile waterDue={waterDue} hasProjects={projects.length > 0} />

          {/* Tile 3: Harvest ready — only when there's at least one fruiting/flowering project.
               When no project is at that stage, the tile is hidden entirely (not shown empty). */}
          {projects.some(p => HARVEST_GATE_STATUSES.has(p.status)) && (
            <HarvestReadyTile harvestReady={harvestReady} onDataRefresh={() => loadDashboard(true)} />
          )}

          {/* Tile 4: Heads up — flagged + stale projects (V1.2a-2 S3 W2) */}
          <HeadsUpTile headsUp={headsUp} onDataRefresh={() => loadDashboard(true)} />

          {/* NotifyButton — push-consent tile, behind NOTIFY_ENABLED flag (default OFF → renders null) */}
          <NotifyButton eventCount={userStats.total_events ?? 0} />

          {/* Footer link to inactive projects surface (V1.2a-2 S3) */}
          {inactiveCount > 0 && (
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <Link to="/inactive" style={{
                display: 'inline-block',
                minHeight: 44,
                padding: '12px 16px',
                color: P.green,
                fontSize: '0.85rem',
                fontWeight: 600,
                textDecoration: 'none',
              }}>
                View {inactiveCount} inactive project{inactiveCount === 1 ? '' : 's'} →
              </Link>
            </div>
          )}
        </ErrorBoundary>

        {/* Active Projects */}
        <section style={{ marginBottom: '32px' }}>
          <h2 style={sectionHeadStyle}>Active projects</h2>
          {projects.length === 0 ? (
            <div style={{
              backgroundColor: P.white, border: `1px solid ${P.border}`,
              borderRadius: 10, padding: '48px 24px', textAlign: 'center',
            }}>
              <div style={{ fontSize: '3rem', marginBottom: 12 }}>🌱</div>
              <p style={{ margin: '0 0 6px', fontWeight: 700, color: P.dark, fontSize: '1rem' }}>
                Nothing planted yet
              </p>
              <p style={{ margin: '0 0 24px', color: P.light, fontSize: '0.875rem' }}>
                Start your first project and the garden tracker comes to life.
              </p>
              <Link to="/projects/new" style={{
                display: 'inline-block',
                backgroundColor: P.green, color: P.white,
                textDecoration: 'none', borderRadius: 8,
                padding: '11px 24px', fontSize: '0.9rem', fontWeight: 700,
              }}>
                Create a project
              </Link>
            </div>
          ) : (
            projects.map(project => {
              const mem = entityMap[project.id]
              return (
                <Link key={project.id} to={`/projects/${project.id}`} style={{ textDecoration: 'none' }}>
                  <div style={{
                    backgroundColor: P.white,
                    border: `1px solid ${P.border}`,
                    borderRadius: '8px',
                    padding: '14px 16px',
                    marginBottom: '8px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    cursor: 'pointer',
                  }}>
                    <div>
                      <div style={{ fontWeight: 600, color: P.green }}>{project.name}</div>
                      <div style={{ fontSize: '0.72rem', color: P.light, marginTop: 2 }}>
                        {mem?.last_event_at
                          ? `${mem.last_event_type?.replace(/_/g, ' ')} · ${daysAgo(mem.last_event_at)}`
                          : 'never logged'}
                      </div>
                    </div>
                    <StatusBadge status={project.status} />
                  </div>
                </Link>
              )
            })
          )}
        </section>

        {/* Recent Activity */}
        {recentEvents.length > 0 && (
          <section>
            <h2 style={sectionHeadStyle}>Recent activity</h2>
            <div style={{
              backgroundColor: P.white,
              border: `1px solid ${P.border}`,
              borderRadius: '10px',
              overflow: 'hidden',
            }}>
              {recentEvents.map((ev, i) => (
                <div key={ev.id} style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '11px 16px',
                  borderBottom: i < recentEvents.length - 1 ? `1px solid ${P.border}` : 'none',
                  gap: '12px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                    <span style={{
                      fontSize: '0.72rem',
                      fontWeight: 600,
                      color: P.green,
                      backgroundColor: P.greenPale,
                      border: `1px solid ${P.greenLight}`,
                      borderRadius: '10px',
                      padding: '2px 9px',
                      flexShrink: 0,
                      whiteSpace: 'nowrap',
                    }}>
                      {ev.event_type?.replace(/_/g, ' ')}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{
                        fontWeight: 500,
                        color: P.dark,
                        fontSize: '0.875rem',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>
                        {ev.project_name ?? '—'}
                      </div>
                    </div>
                  </div>
                  <span style={{ fontSize: '0.75rem', color: P.light, flexShrink: 0, whiteSpace: 'nowrap' }}>
                    {relativeTime(ev.created_at)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* Streak modal */}
      {streakModalOpen && (
        <StreakModal
          stats={userStats}
          onClose={() => setStreakModalOpen(false)}
        />
      )}

      {/* Achievement toast (top, auto-dismiss 2s, click-to-dismiss) */}
      {currentToast && <AchievementToast achievement={currentToast} onDismiss={() => setCurrentToast(null)} />}

      {/* Undo toast (bottom, 5s) */}
      {undoState && <UndoToast state={undoState} onUndo={handleUndo} onDismiss={() => setUndoState(null)} />}

      {/* Pulse keyframes */}
      <style>{`
        @keyframes streakPulse {
          0%   { transform: scale(1);   }
          30%  { transform: scale(1.18); }
          60%  { transform: scale(0.96); }
          100% { transform: scale(1);   }
        }
      `}</style>
    </div>
  )
}

// ─── Streak Counter (top-right header) ────────────────────────────────────────
function StreakCounter({ streak, pulseKey, onTap }) {
  return (
    <button
      type="button"
      onClick={onTap}
      aria-label={streak > 0 ? `Streak: ${streak} days` : 'Start your streak today'}
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        flexShrink: 0,
      }}
    >
      <div
        key={pulseKey}
        style={{
          fontSize: '1.6rem',
          lineHeight: 1,
          animation: pulseKey > 0 ? 'streakPulse 600ms ease-out' : 'none',
        }}
      >
        🔥
      </div>
      <div style={{
        fontSize: streak > 0 ? '1.1rem' : '0.7rem',
        fontWeight: 700,
        color: streak > 0 ? P.terra : P.light,
        marginTop: 4,
        textAlign: 'right',
      }}>
        {streak > 0 ? streak : 'Start your streak today'}
      </div>
    </button>
  )
}

// ─── Streak Modal — current / longest / next milestone ───────────────────────
function StreakModal({ stats, onClose }) {
  const current = stats.current_streak ?? 0
  const nextMilestone = STREAK_MILESTONES.find(m => m > current) ?? null
  const daysToMilestone = nextMilestone ? nextMilestone - current : null

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        backgroundColor: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20, zIndex: 1000,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          backgroundColor: P.white,
          borderRadius: 14,
          padding: '28px 24px',
          maxWidth: 360,
          width: '100%',
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div style={{ fontSize: '3rem', lineHeight: 1, marginBottom: 8 }}>🔥</div>
          <div style={{ fontSize: '2.2rem', fontWeight: 800, color: P.terra, lineHeight: 1 }}>{current}</div>
          <div style={{ fontSize: '0.85rem', color: P.mid, marginTop: 6 }}>
            {current === 0 ? 'No streak yet' : current === 1 ? 'day' : 'day streak'}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 10, marginBottom: 20 }}>
          <Row label="Longest streak"  value={`${stats.longest_streak ?? 0} day${(stats.longest_streak ?? 0) === 1 ? '' : 's'}`} />
          <Row label="Last active"     value={formatLastActive(stats.last_active_date)} />
          <Row label="Total events"    value={`${stats.total_events ?? 0}`} />
          <Row label="XP"              value={`${stats.xp ?? 0}`} />
        </div>

        <div style={{
          backgroundColor: P.greenPale,
          border: `1px solid ${P.greenLight}`,
          borderRadius: 8,
          padding: '12px 16px',
          textAlign: 'center',
          fontSize: '0.88rem',
          color: P.green,
          fontWeight: 600,
          marginBottom: 16,
        }}>
          {nextMilestone === null
            ? '🏆 All streak achievements earned'
            : `Next milestone: ${nextMilestone} days · ${daysToMilestone} to go`}
        </div>

        <button onClick={onClose} style={{
          width: '100%',
          backgroundColor: P.green, color: P.white,
          border: 'none', borderRadius: 8,
          padding: '12px', fontSize: '0.95rem', fontWeight: 700, cursor: 'pointer',
        }}>
          Close
        </button>
      </div>
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '8px 12px',
      backgroundColor: P.cream,
      border: `1px solid ${P.border}`,
      borderRadius: 8,
      fontSize: '0.85rem',
    }}>
      <span style={{ color: P.mid }}>{label}</span>
      <span style={{ color: P.dark, fontWeight: 600 }}>{value}</span>
    </div>
  )
}

// ─── Tile 1: Give attention to (non-hide zero state) ─────────────────────────
function GiveAttentionTile({ nextAttention, hasProjects }) {
  if (!hasProjects) return null

  // "All caught up 🌱" zero state when there are projects but none need attention
  if (!nextAttention) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '14px 16px',
        backgroundColor: P.greenPale,
        border: `1.5px solid ${P.greenLight}`,
        borderRadius: '10px',
        marginBottom: '12px',
      }}>
        <span style={{ fontSize: '1.4rem' }}>🌱</span>
        <div>
          <div style={{ fontSize: '0.75rem', color: P.mid, fontWeight: 500, marginBottom: '1px' }}>
            GIVE ATTENTION TO
          </div>
          <div style={{ fontWeight: 700, color: P.green, fontSize: '0.95rem' }}>
            All caught up
          </div>
        </div>
      </div>
    )
  }

  return (
    <Link to={`/projects/${nextAttention.id}`} style={{ textDecoration: 'none', display: 'block', marginBottom: '12px' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        backgroundColor: '#f0f7f0',
        border: `1.5px solid ${P.greenLight}`,
        borderRadius: '10px',
        cursor: 'pointer',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '1.2rem' }}>🌱</span>
          <div>
            <div style={{ fontSize: '0.75rem', color: P.mid, fontWeight: 500, marginBottom: '1px' }}>
              GIVE ATTENTION TO
            </div>
            <div style={{ fontWeight: 700, color: P.green, fontSize: '0.95rem' }}>
              {nextAttention.name}
            </div>
          </div>
        </div>
        <span style={{ fontSize: '0.8rem', color: P.mid, flexShrink: 0 }}>
          {daysAgo(nextAttention.last_event_at)}
        </span>
      </div>
    </Link>
  )
}

// ─── Tile 2: Water me (3 states + severity tiers) ────────────────────────────
function WaterMeTile({ waterDue, hasProjects }) {
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(false)

  if (!hasProjects) return null

  // BUG-05a (2.1.1): hide the "set a watering rhythm" dead-end primer.
  // There is no watering-schedule UI to set yet (planting-level schedule = BUG-05b /
  // Care Profiles, unbuilt). Advertising an unbuildable action is a Catch-up-class
  // dead-end, so render nothing when no watering is actually due.
  if (waterDue.length === 0) return null

  function goToLog(projectId) {
    navigate(`/log?project=${projectId}&event_type=watering`)
  }

  // Single result
  if (waterDue.length === 1) {
    const w = waterDue[0]
    const tier = severityTier(w.next_water_at, w.location_type)
    const s = SEVERITY_STYLES[tier]
    return (
      <button
        type="button"
        onClick={() => goToLog(w.project_id)}
        style={{
          display: 'block', width: '100%', textAlign: 'left',
          padding: '14px 16px',
          backgroundColor: s.bg,
          border: `1.5px solid ${s.border}`,
          borderRadius: '10px',
          cursor: 'pointer',
          marginBottom: '28px',
        }}
      >
        <div style={{ fontSize: '0.75rem', color: P.mid, fontWeight: 500, marginBottom: '4px' }}>
          💧 WATER ME
        </div>
        <div style={{ fontWeight: 700, color: s.text, fontSize: '0.95rem', marginBottom: '2px' }}>
          {w.project_name}
        </div>
        <div style={{ fontSize: '0.78rem', color: P.mid }}>
          {w.last_watered_at
            ? `Last watered ${absoluteDate(w.last_watered_at)} (${daysAgo(w.last_watered_at)})`
            : 'Never watered'}
        </div>
      </button>
    )
  }

  // Multiple results — show top severity, expandable list
  const top = waterDue[0]
  const topTier = severityTier(top.next_water_at, top.location_type)
  const s = SEVERITY_STYLES[topTier]

  return (
    <div style={{
      backgroundColor: s.bg,
      border: `1.5px solid ${s.border}`,
      borderRadius: '10px',
      marginBottom: '28px',
      overflow: 'hidden',
    }}>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'block', width: '100%', textAlign: 'left',
          padding: '14px 16px',
          background: 'none', border: 'none', cursor: 'pointer',
        }}
      >
        <div style={{ fontSize: '0.75rem', color: P.mid, fontWeight: 500, marginBottom: '4px' }}>
          💧 WATER ME
        </div>
        <div style={{ fontWeight: 700, color: s.text, fontSize: '0.95rem', marginBottom: '2px' }}>
          Water {top.project_name} + {waterDue.length - 1} more
        </div>
        <div style={{ fontSize: '0.78rem', color: P.mid }}>
          {expanded ? 'Tap row to log · ▾' : 'Tap to see all · ▸'}
        </div>
      </button>
      {expanded && (
        <div style={{ borderTop: `1px solid ${s.border}` }}>
          {waterDue.map((w, i) => {
            const t = severityTier(w.next_water_at, w.location_type)
            const ts = SEVERITY_STYLES[t]
            return (
              <button
                key={w.project_id}
                type="button"
                onClick={() => goToLog(w.project_id)}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  width: '100%', textAlign: 'left',
                  padding: '11px 16px',
                  background: P.white,
                  border: 'none',
                  borderBottom: i < waterDue.length - 1 ? `1px solid ${s.border}` : 'none',
                  cursor: 'pointer',
                  gap: 12,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{
                    fontWeight: 600, color: ts.text, fontSize: '0.88rem',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {w.project_name}
                  </div>
                  <div style={{ fontSize: '0.72rem', color: P.light, marginTop: 1 }}>
                    {w.last_watered_at
                      ? `last ${daysAgo(w.last_watered_at)}`
                      : 'never watered'}
                  </div>
                </div>
                <span style={{ fontSize: '0.78rem', color: ts.text, fontWeight: 600, flexShrink: 0 }}>
                  Log →
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Toasts ──────────────────────────────────────────────────────────────────
function AchievementToast({ achievement, onDismiss }) {
  return (
    <button
      type="button"
      onClick={onDismiss}
      aria-label={`Dismiss achievement: ${achievement.name}`}
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 70,
        left: '50%',
        transform: 'translateX(-50%)',
        backgroundColor: P.gold,
        color: P.white,
        border: 'none',
        borderRadius: 10,
        padding: '12px 20px',
        boxShadow: '0 6px 18px rgba(0,0,0,0.22)',
        fontSize: '0.95rem',
        fontWeight: 600,
        zIndex: 1100,
        display: 'flex', alignItems: 'center', gap: 10,
        animation: 'streakPulse 400ms ease-out',
        cursor: 'pointer',
      }}
    >
      <span style={{ fontSize: '1.4rem' }}>{achievement.emoji ?? '🏆'}</span>
      <div style={{ textAlign: 'left' }}>
        <div style={{ lineHeight: 1.2 }}>{achievement.name}</div>
        <div style={{ fontSize: '0.78rem', opacity: 0.92, marginTop: 2 }}>
          +{achievement.xp_reward ?? 0} XP
        </div>
      </div>
      <span style={{ fontSize: '0.85rem', opacity: 0.7, marginLeft: 4 }}>✕</span>
    </button>
  )
}

function UndoToast({ state, onUndo, onDismiss }) {
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        bottom: 70,
        left: '50%',
        transform: 'translateX(-50%)',
        backgroundColor: P.dark,
        color: P.white,
        borderRadius: 10,
        padding: '10px 14px 10px 18px',
        boxShadow: '0 6px 18px rgba(0,0,0,0.3)',
        fontSize: '0.88rem',
        zIndex: 1000,
        display: 'flex', alignItems: 'center', gap: 14,
        maxWidth: 'calc(100% - 32px)',
      }}
    >
      <span>Logged event for {state.projectName}.</span>
      <button
        type="button"
        onClick={onUndo}
        style={{
          background: 'transparent',
          color: P.greenLight,
          border: `1px solid ${P.greenLight}`,
          borderRadius: 6,
          padding: '5px 12px',
          fontSize: '0.85rem',
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        Undo
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          background: 'transparent', color: P.light,
          border: 'none', cursor: 'pointer',
          fontSize: '0.95rem', padding: '0 4px',
        }}
      >
        ✕
      </button>
    </div>
  )
}

// ─── Utilities ───────────────────────────────────────────────────────────────
function daysAgo(dateStr) {
  const d = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000)
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`
}

// ADHD-friendly local-date format for user_stats.last_active_date.
// Backend stores DATE in user's TZ; neon serverless serializes as UTC midnight
// (e.g., "2026-05-12T00:00:00.000Z"). Naively parsing with new Date() can shift
// the date back one day in negative-offset TZs. Extract YYYY-MM-DD and build a
// local-tz Date to avoid the shift.
function formatLastActive(dateStr) {
  if (!dateStr) return 'never'
  const ymd = dateStr.slice(0, 10).split('-').map(Number)
  if (ymd.length !== 3 || ymd.some(Number.isNaN)) return dateStr
  const [y, m, d] = ymd
  const local = new Date(y, m - 1, d)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diffDays = Math.round((today.getTime() - local.getTime()) / 86400000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  const wd = local.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  if (diffDays > 1 && diffDays < 7) return `${wd} (${diffDays} days ago)`
  return wd
}

function absoluteDate(dateStr) {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function relativeTime(isoStr) {
  const diffMs = Date.now() - new Date(isoStr).getTime()
  const mins  = Math.floor(diffMs / 60000)
  const hours = Math.floor(diffMs / 3600000)
  const days  = Math.floor(diffMs / 86400000)
  if (mins < 1)   return 'just now'
  if (mins < 60)  return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days === 1) return 'yesterday'
  return `${days}d ago`
}

function StatusBadge({ status }) {
  // I7 fix (2026-05-18, V1.2a-3 Increment C / PR-C2): use unified status colors from
  // src/lib/status.js so badge color is consistent across Dashboard / ProjectList / ProjectDetail.
  const c = getStatusColors(status)
  return (
    <span style={{
      backgroundColor: c.bg,
      color: c.text,
      border: `1px solid ${c.border}`,
      fontSize: '0.75rem',
      padding: '2px 10px',
      borderRadius: '12px',
      fontWeight: 500,
      flexShrink: 0,
    }}>
      {status}
    </span>
  )
}

const sectionHeadStyle = {
  color: P.dark,
  fontSize: '0.95rem',
  fontWeight: 700,
  margin: '0 0 12px',
}

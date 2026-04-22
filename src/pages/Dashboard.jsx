import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { useZone } from '../context/ZoneContext.jsx'
import { supabase } from '../lib/supabase.js'
import { P, PROJECT_STATUSES } from '../lib/constants.js'

// Project statuses eligible for display on Dashboard — same filter as EventNew.jsx
// PROVISIONAL: harvesting excluded — review if users want to see harvesting projects here
const LOGGABLE_STATUSES = PROJECT_STATUSES.filter(s => s !== 'harvesting')

export default function Dashboard() {
  const { profile } = useAuth()
  const { activeZone } = useZone()
  const location = useLocation()
  const [projects,      setProjects]      = useState([])
  const [tasks,         setTasks]         = useState([])
  const [nextAttention, setNextAttention] = useState(null)
  const [entityMap,     setEntityMap]     = useState({})
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState(null)

  useEffect(() => {
    let isMounted = true
    loadDashboard(isMounted)
    return () => { isMounted = false }
  }, [])

  async function loadDashboard(isMounted) {
    const today = new Date().toISOString().split('T')[0]

    try {
      const [
        { data: projectData, error: pErr },
        { data: taskData,    error: tErr },
        { data: emData },
      ] = await Promise.all([
        supabase
          .from('plant_projects')
          .select('id, name, slug, status, start_date, location_id')
          .in('status', LOGGABLE_STATUSES)
          .order('start_date', { ascending: false }),
        supabase
          .from('tasks')
          .select('id, title, due_date, priority, status')
          .lte('due_date', today)
          .eq('status', 'pending')
          .order('due_date'),
        supabase
          .from('entity_memory')
          .select('project_id, last_event_at, last_event_type'),
      ])

      if (pErr) throw pErr
      if (tErr) throw tErr

      if (isMounted) {
        const activeProjects = projectData ?? []
        setProjects(activeProjects)
        setTasks(taskData ?? [])

        if (activeProjects.length > 0) {
          const activeIds = new Set(activeProjects.map(p => p.id))
          const memMap = {}
          ;(emData ?? []).forEach(row => {
            if (activeIds.has(row.project_id)) memMap[row.project_id] = row
          })
          setEntityMap(memMap)

          // Project with no memory entry = never logged = highest priority
          const neverLogged = activeProjects.find(p => !memMap[p.id])
          if (neverLogged) {
            setNextAttention({ id: neverLogged.id, name: neverLogged.name, last_event_at: null })
          } else {
            const oldest = activeProjects.reduce((acc, p) =>
              !acc || memMap[p.id].last_event_at < memMap[acc.id].last_event_at ? p : acc, null)
            if (oldest) setNextAttention({ id: oldest.id, name: oldest.name, last_event_at: memMap[oldest.id].last_event_at })
          }
        }
      }
    } catch (err) {
      if (isMounted) setError(err.message)
    } finally {
      if (isMounted) setLoading(false)
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
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '32px 20px' }}>

        {/* Header */}
        <h1 style={{ color: P.green, fontSize: '1.4rem', fontWeight: 700, margin: '0 0 4px' }}>
          Welcome back, {profile?.display_name ?? 'Dave'} 🌿
        </h1>
        <p style={{ color: P.light, fontSize: '0.875rem', margin: '0 0 20px' }}>{today}</p>

        {/* Zone context strip */}
        <Link
          to={`/zone?from=${encodeURIComponent(location.pathname)}`}
          style={{ textDecoration: 'none', display: 'block', marginBottom: '16px' }}
        >
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            backgroundColor: activeZone ? P.greenPale : P.white,
            border: `1.5px solid ${activeZone ? P.green : P.border}`,
            borderRadius: '10px',
            cursor: 'pointer',
            transition: 'border-color 150ms',
          }}
            onMouseEnter={e => e.currentTarget.style.borderColor = P.greenLight}
            onMouseLeave={e => e.currentTarget.style.borderColor = activeZone ? P.green : P.border}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '1.2rem' }}>📍</span>
              <div>
                <div style={{ fontSize: '0.75rem', color: P.mid, fontWeight: 500, marginBottom: '1px' }}>
                  WHERE ARE YOU?
                </div>
                <div style={{ fontWeight: 700, color: activeZone ? P.green : P.dark, fontSize: '0.95rem' }}>
                  {activeZone ? activeZone.name : 'Everywhere'}
                </div>
              </div>
            </div>
            <span style={{ fontSize: '0.8rem', color: P.mid }}>Change →</span>
          </div>
        </Link>

        {/* Give attention to */}
        {nextAttention && (
          <Link to={`/projects/${nextAttention.id}`} style={{ textDecoration: 'none', display: 'block', marginBottom: '28px' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              backgroundColor: '#f0f7f0',
              border: `1.5px solid ${P.greenLight}`,
              borderRadius: '10px',
              cursor: 'pointer',
              transition: 'border-color 150ms',
            }}
              onMouseEnter={e => e.currentTarget.style.borderColor = P.green}
              onMouseLeave={e => e.currentTarget.style.borderColor = P.greenLight}
            >
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
                {nextAttention.last_event_at ? daysAgo(nextAttention.last_event_at) : 'never logged'}
              </span>
            </div>
          </Link>
        )}

        {/* Overdue / Due Today tasks */}
        {tasks.length > 0 && (
          <section style={{ marginBottom: '32px' }}>
            <h2 style={{ ...sectionHeadStyle, marginBottom: '12px' }}>⚠️ Needs attention today</h2>
            {tasks.map(task => (
              <div key={task.id} style={{
                backgroundColor: P.warn,
                border: `1px solid ${P.warnBorder}`,
                borderRadius: '8px',
                padding: '12px 16px',
                marginBottom: '8px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}>
                <span style={{ fontWeight: 500, color: P.dark }}>{task.title}</span>
                <span style={{ fontSize: '0.8rem', color: P.mid, flexShrink: 0, marginLeft: '12px' }}>
                  {task.due_date}
                </span>
              </div>
            ))}
          </section>
        )}

        {/* Active Projects */}
        <section>
          <h2 style={sectionHeadStyle}>Active projects</h2>
          {projects.length === 0 ? (
            <div style={{
              backgroundColor: P.white,
              border: `1px solid ${P.border}`,
              borderRadius: '8px',
              padding: '28px 20px',
              textAlign: 'center',
              color: P.light,
              fontSize: '0.9rem',
            }}>
              No active projects yet.{' '}
              <span style={{ color: P.green, cursor: 'pointer' }}>Create your first plant project →</span>
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
                  }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = P.greenLight}
                    onMouseLeave={e => e.currentTarget.style.borderColor = P.border}
                  >
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

      </div>
    </div>
  )
}

function daysAgo(dateStr) {
  const d = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000)
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`
}

function StatusBadge({ status }) {
  // TODO (Session B): expand color map for full lifecycle (seeding, sprouting, growing, flowering, fruiting)
  // New statuses currently fall through to planning style (yellow) via the fallback.
  const colors = {
    planning:  { bg: P.warn,      text: '#7a5c00', border: P.warnBorder },
    active:    { bg: P.greenPale, text: P.green,   border: P.greenLight },
    seeding:   { bg: P.greenPale, text: P.green,   border: P.greenLight },
    sprouting: { bg: P.greenPale, text: P.green,   border: P.greenLight },
    growing:   { bg: P.greenPale, text: P.green,   border: P.greenLight },
    flowering: { bg: P.greenPale, text: P.green,   border: P.greenLight },
    fruiting:  { bg: P.greenPale, text: P.green,   border: P.greenLight },
    harvested: { bg: '#eee',      text: P.mid,     border: P.border },
    ended:     { bg: '#eee',      text: P.light,   border: P.border },
  }
  const c = colors[status] ?? colors.planning
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

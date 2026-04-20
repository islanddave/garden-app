import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { supabase } from '../lib/supabase.js'
import { P, PROJECT_STATUSES } from '../lib/constants.js'

export default function Dashboard() {
  const { profile } = useAuth()
  const [projects,  setProjects]  = useState([])
  const [tasks,     setTasks]     = useState([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState(null)

  useEffect(() => {
    let isMounted = true
    loadDashboard(isMounted)
    return () => { isMounted = false }
  }, [])

  async function loadDashboard(isMounted) {
    const today = new Date().toISOString().split('T')[0]

    try {
      const [{ data: projectData, error: pErr }, { data: taskData, error: tErr }] = await Promise.all([
        supabase
          .from('plant_projects')
          .select('id, name, slug, status, start_date, location_id')
          .eq('status', 'active')
          .order('start_date', { ascending: false }),
        supabase
          .from('tasks')
          .select('id, title, due_date, priority, status')
          .lte('due_date', today)
          .eq('status', 'pending')
          .order('due_date'),
      ])

      if (pErr) throw pErr
      if (tErr) throw tErr

      if (isMounted) {
        setProjects(projectData ?? [])
        setTasks(taskData ?? [])
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
    <div style={{ minHeight: 'calc(100vh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '32px 20px' }}>

        {/* Header */}
        <h1 style={{ color: P.green, fontSize: '1.4rem', fontWeight: 700, margin: '0 0 4px' }}>
          Welcome back, {profile?.display_name ?? 'Dave'} 🌿
        </h1>
        <p style={{ color: P.light, fontSize: '0.875rem', margin: '0 0 32px' }}>{today}</p>

        {tasks.length > 0 && (
          <section style={{ marginBottom: '32px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '12px' }}>
              <h2 style={{ ...sectionHeadStyle, margin: 0 }}>⚠️ Needs attention today</h2>
              <Link to="/tasks" style={{ fontSize: '0.8rem', color: P.green, textDecoration: 'none', fontWeight: 500 }}>
                View all tasks →
              </Link>
            </div>
            {tasks.map(task => (
              <Link key={task.id} to="/tasks" style={{ textDecoration: 'none', display: 'block' }}>
                <div style={{
                  backgroundColor: P.warn,
                  border: `1px solid ${P.warnBorder}`,
                  borderRadius: '8px',
                  padding: '12px 16px',
                  marginBottom: '8px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  cursor: 'pointer',
                }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = P.terra}
                  onMouseLeave={e => e.currentTarget.style.borderColor = P.warnBorder}
                >
                  <span style={{ fontWeight: 500, color: P.dark }}>{task.title}</span>
                  <span style={{ fontSize: '0.8rem', color: P.mid, flexShrink: 0, marginLeft: '12px' }}>
                    {task.due_date}
                  </span>
                </div>
              </Link>
            ))}
          </section>
        )}

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
            projects.map(project => (
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
                  <span style={{ fontWeight: 600, color: P.green }}>{project.name}</span>
                  <StatusBadge status={project.status} />
                </div>
              </Link>
            ))
          )}
        </section>

      </div>
    </div>
  )
}

function StatusBadge({ status }) {
  const colors = {
    planning:  { bg: P.warn,      text: '#7a5c00', border: P.warnBorder },
    active:    { bg: P.greenPale, text: P.green,   border: P.greenLight },
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

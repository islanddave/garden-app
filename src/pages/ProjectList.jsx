import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'

const STATUS_COLORS = {
  planning:  { bg: '#fff8e6', text: '#7a5c00', border: '#c9a84c' },
  active:    { bg: '#d8f3dc', text: '#2d6a4f', border: '#52b788' },
  harvested: { bg: '#eee',    text: '#4a4a4a', border: '#d4c9be' },
  ended:     { bg: '#eee',    text: '#777',    border: '#d4c9be' },
}

// Build a display-ordered list: root projects first, then their children immediately after,
// with depth tracked for indentation. Orphaned children (parent deleted/missing) render as root.
function buildDisplayList(projects) {
  const byId = {}
  projects.forEach(p => { byId[p.id] = p })

  const roots = []
  const childrenOf = {}
  projects.forEach(p => {
    const pid = p.parent_project_id
    if (!pid || !byId[pid]) {
      roots.push(p)
    } else {
      if (!childrenOf[pid]) childrenOf[pid] = []
      childrenOf[pid].push(p)
    }
  })

  const result = []
  function walk(project, depth) {
    result.push({ project, depth })
    const kids = childrenOf[project.id] ?? []
    kids.forEach(child => walk(child, depth + 1))
  }
  roots.forEach(r => walk(r, 0))
  return result
}

export default function ProjectList() {
  const { fetch } = useApiFetch()
  const [projects, setProjects] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)

  useEffect(() => {
    let isMounted = true
    fetch('/api/projects')
      .then(data => {
        if (!isMounted) return
        setProjects(data ?? [])
        setLoading(false)
      })
      .catch(err => {
        if (!isMounted) return
        setError(err.message)
        setLoading(false)
      })
    return () => { isMounted = false }
  }, [fetch])

  if (loading) return <Shell><Spinner /></Shell>
  if (error)   return <Shell><ErrMsg msg={error} /></Shell>

  const displayList = buildDisplayList(projects)

  return (
    <Shell>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Projects</h1>
        <Link to="/projects/new" style={btnLink}>+ New project</Link>
      </div>

      {/* List */}
      {displayList.length === 0 ? (
        <ProjectsEmptyState />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {displayList.map(({ project: p, depth }) => (
            <ProjectCard key={p.id} project={p} depth={depth} />
          ))}
        </div>
      )}
    </Shell>
  )
}

function ProjectCard({ project: p, depth }) {
  const sc = STATUS_COLORS[p.status] ?? STATUS_COLORS.planning
  const indent = depth * 16
  return (
    <div style={{ paddingLeft: indent }}>
      {depth > 0 && (
        <span style={{ color: P.light, fontSize: '0.85rem', marginRight: 6, display: 'inline-block', marginBottom: -2 }}>
          └
        </span>
      )}
      <Link to={`/projects/${p.id}`} style={{ textDecoration: 'none', display: 'block' }}>
        <div style={{
          backgroundColor: P.white,
          border: `1px solid ${P.border}`,
          borderRadius: 8,
          padding: '14px 18px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          cursor: 'pointer',
          transition: 'border-color 0.15s',
        }}
          onMouseEnter={e => e.currentTarget.style.borderColor = P.greenLight}
          onMouseLeave={e => e.currentTarget.style.borderColor = P.border}
        >
          {/* Name + meta */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, color: P.green, fontSize: '0.95rem' }}>{p.name}</span>
              {p.variety && (
                <span style={{ fontSize: '0.8rem', color: P.mid }}>{p.variety}</span>
              )}
              {!p.is_public && (
                <span style={{ fontSize: '0.7rem', color: P.light, backgroundColor: '#eee', borderRadius: 10, padding: '1px 7px' }}>
                  private
                </span>
              )}
            </div>
            {p.location_path && (
              <div style={{ fontSize: '0.78rem', color: P.mid, marginTop: 3 }}>
                📍 {p.location_path}
              </div>
            )}
            {p.start_date && (
              <div style={{ fontSize: '0.75rem', color: P.light, marginTop: 2 }}>
                Started {new Date(p.start_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </div>
            )}
          </div>

          {/* Status badge */}
          <span style={{
            backgroundColor: sc.bg, color: sc.text, border: `1px solid ${sc.border}`,
            fontSize: '0.75rem', padding: '3px 10px', borderRadius: 12, fontWeight: 600, flexShrink: 0,
          }}>
            {p.status}
          </span>

          {/* Arrow */}
          <span style={{ color: P.border, fontSize: '1rem', flexShrink: 0 }}>›</span>
        </div>
      </Link>
    </div>
  )
}

// ---- Shared UI ----
function Shell({ children }) {
  return (
    <div style={{ minHeight: 'calc(100vh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px' }}>{children}</div>
    </div>
  )
}
function Spinner() { return <div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div> }
function ErrMsg({ msg }) { return <div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{msg}</div> }

function ProjectsEmptyState() {
  return (
    <div style={{
      textAlign: 'center', padding: '48px 24px',
      backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 8,
    }}>
      <div style={{ fontSize: '3rem', marginBottom: 12 }}>🌿</div>
      <p style={{ margin: '0 0 6px', fontWeight: 700, color: P.dark, fontSize: '1rem' }}>
        No projects yet
      </p>
      <p style={{ margin: '0 0 24px', color: P.light, fontSize: '0.875rem' }}>
        Each project tracks a plant or crop from start to harvest.
      </p>
      <Link to="/projects/new" style={btnLink}>
        Create your first project
      </Link>
    </div>
  )
}

const btnLink = {
  backgroundColor: P.green, color: P.white, textDecoration: 'none',
  borderRadius: 6, padding: '9px 18px', fontSize: '0.88rem', fontWeight: 600,
}

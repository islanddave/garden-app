import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { P } from '../lib/constants.js'

const STATUS_COLORS = {
  planning:  { bg: '#fff8e6', text: '#7a5c00', border: '#c9a84c' },
  active:    { bg: '#d8f3dc', text: '#2d6a4f', border: '#52b788' },
  harvested: { bg: '#eee',    text: '#4a4a4a', border: '#d4c9be' },
  ended:     { bg: '#eee',    text: '#777',    border: '#d4c9be' },
}

export default function ProjectList() {
  const [projects, setProjects] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)

  useEffect(() => {
    let isMounted = true
    ;(async () => {
      const { data: projects, error: pErr } = await supabase
        .from('plant_projects')
        .select('id, name, slug, status, variety, start_date, is_public, location_id')
        .order('start_date', { ascending: false, nullsFirst: false })

      if (!isMounted) return
      if (pErr) { setError(pErr.message); setLoading(false); return }

      const locIds = [...new Set((projects ?? []).map(p => p.location_id).filter(Boolean))]
      let pathMap = {}
      if (locIds.length) {
        const { data: locs } = await supabase
          .from('locations_with_path')
          .select('id, full_path')
          .in('id', locIds)
        ;(locs ?? []).forEach(l => { pathMap[l.id] = l.full_path })
      }

      if (isMounted) {
        setProjects((projects ?? []).map(p => ({ ...p, location_path: pathMap[p.location_id] ?? null })))
        setLoading(false)
      }
    })()
    return () => { isMounted = false }
  }, [])

  if (loading) return <Shell><Spinner /></Shell>
  if (error)   return <Shell><ErrMsg msg={error} /></Shell>

  return (
    <Shell>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Projects</h1>
        <Link to="/projects/new" style={btnLink}>+ New project</Link>
      </div>
      {projects.length === 0 ? (
        <Empty msg="No projects yet. Create your first one!" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {projects.map(p => <ProjectCard key={p.id} project={p} />)}
        </div>
      )}
    </Shell>
  )
}

function ProjectCard({ project: p }) {
  const sc = STATUS_COLORS[p.status] ?? STATUS_COLORS.planning
  return (
    <Link to={`/projects/${p.id}`} style={{ textDecoration: 'none' }}>
      <div style={{
        backgroundColor: P.white, border: `1px solid ${P.border}`,
        borderRadius: 8, padding: '14px 18px',
        display: 'flex', alignItems: 'center', gap: 12,
        cursor: 'pointer', transition: 'border-color 0.15s',
      }}
        onMouseEnter={e => e.currentTarget.style.borderColor = P.greenLight}
        onMouseLeave={e => e.currentTarget.style.borderColor = P.border}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, color: P.green, fontSize: '0.95rem' }}>{p.name}</span>
            {p.variety && <span style={{ fontSize: '0.8rem', color: P.mid }}>{p.variety}</span>}
            {!p.is_public && <span style={{ fontSize: '0.7rem', color: P.light, backgroundColor: '#eee', borderRadius: 10, padding: '1px 7px' }}>private</span>}
          </div>
          {p.location_path && <div style={{ fontSize: '0.78rem', color: P.mid, marginTop: 3 }}>📍 {p.location_path}</div>}
          {p.start_date && <div style={{ fontSize: '0.75rem', color: P.light, marginTop: 2 }}>Started {new Date(p.start_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>}
        </div>
        <span style={{ backgroundColor: sc.bg, color: sc.text, border: `1px solid ${sc.border}`, fontSize: '0.75rem', padding: '3px 10px', borderRadius: 12, fontWeight: 600, flexShrink: 0 }}>{p.status}</span>
        <span style={{ color: P.border, fontSize: '1rem', flexShrink: 0 }}>›</span>
      </div>
    </Link>
  )
}

function Shell({ children }) {
  return <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}><div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px' }}>{children}</div></div>
}
function Spinner() { return <div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div> }
function ErrMsg({ msg }) { return <div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{msg}</div> }
function Empty({ msg }) {
  return <div style={{ textAlign: 'center', color: P.light, padding: '40px 20px', fontSize: '0.9rem', backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 8 }}>{msg}</div>
}
const btnLink = { backgroundColor: P.green, color: P.white, textDecoration: 'none', borderRadius: 6, padding: '9px 18px', fontSize: '0.88rem', fontWeight: 600 }

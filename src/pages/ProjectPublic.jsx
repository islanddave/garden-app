import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { apiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'

function formatDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

const EVENT_ICONS = {
  sowing:'🌱',seed_soak:'💧',germination:'🌿',thinning:'✂️',potting_up:'🪴',
  transplant:'🔄',hardening_off:'☀️',watering:'💧',fertilizing:'🧪',pest_treatment:'🐛',
  pruning:'✂️',cover:'🏕️',uncover:'🌤️',first_harvest:'🎉',harvest:'🧺',
  observation:'👁️',photo:'📷',other:'📝',
}

export default function ProjectPublic() {
  const { slug } = useParams()
  const [project, setProject] = useState(null)
  const [events,  setEvents]  = useState([])
  const [locPath, setLocPath] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound,setNotFound]= useState(false)

  useEffect(() => {
    let isMounted = true
    apiFetch('/api/projects/public/' + slug)
      .then(proj => {
        if (!isMounted) return
        if (!proj) { setNotFound(true); setLoading(false); return }
        setProject(proj)
        setEvents((proj.events || []).filter(Boolean))
        setLocPath(proj.location_path ?? null)
        setLoading(false)
      })
      .catch(() => {
        if (!isMounted) return
        setNotFound(true)
        setLoading(false)
      })
    return () => { isMounted = false }
  }, [slug])

  if (loading) return <Page><div style={{ padding: '80px 20px', textAlign: 'center', color: P.light }}>Loading…</div></Page>
  if (notFound) return (
    <Page><div style={{ padding: '80px 20px', textAlign: 'center' }}>
      <div style={{ fontSize: '3rem', marginBottom: 16 }}>🌿</div>
      <h1 style={{ color: P.green, marginBottom: 8 }}>Project not found</h1>
      <p style={{ color: P.light, marginBottom: 24 }}>This project doesn't exist or isn't public.</p>
      <Link to="/" style={{ color: P.green, textDecoration: 'none', fontSize: '0.9rem' }}>← Back to home</Link>
    </div></Page>
  )

  return (
    <Page>
      <div style={{ maxWidth: 680, margin: '0 auto', padding: '40px 20px' }}>
        <div style={{ marginBottom: 32 }}>
          <h1 style={{ margin: '0 0 8px', color: P.green, fontSize: '1.8rem', fontWeight: 700 }}>{project.name}</h1>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            {project.variety && <span style={{ fontSize: '0.9rem', color: P.mid }}>{project.variety}</span>}
            {project.species && <span style={{ fontSize: '0.85rem', color: P.light, fontStyle: 'italic' }}>{project.species}</span>}
            <StatusBadge status={project.status} />
          </div>
          {locPath && <div style={{ fontSize: '0.875rem', color: P.mid, marginBottom: 8 }}>📍 {locPath}</div>}
          {project.start_date && <div style={{ fontSize: '0.82rem', color: P.light }}>Started {formatDate(project.start_date)}</div>}
          {project.description && <p style={{ marginTop: 16, color: P.dark, lineHeight: 1.6, fontSize: '0.95rem' }}>{project.description}</p>}
        </div>
        <hr style={{ border: 'none', borderTop: `1px solid ${P.border}`, margin: '0 0 28px' }} />
        <h2 style={{ margin: '0 0 20px', color: P.dark, fontSize: '1rem', fontWeight: 700 }}>
          Updates {events.length > 0 && <span style={{ color: P.light, fontWeight: 400, fontSize: '0.85rem' }}>({events.length})</span>}
        </h2>
        {events.length === 0 ? (
          <div style={{ color: P.light, fontSize: '0.875rem', padding: '32px 0', textAlign: 'center' }}>No updates yet.</div>
        ) : (
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', left: 18, top: 0, bottom: 0, width: 2, backgroundColor: P.border }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {events.map((ev, i) => <EventEntry key={ev.id} event={ev} isLast={i === events.length - 1} />)}
            </div>
          </div>
        )}
      </div>
    </Page>
  )
}

function EventEntry({ event: ev, isLast }) {
  const icon = EVENT_ICONS[ev.event_type] ?? '📝'
  return (
    <div style={{ display: 'flex', gap: 14, paddingBottom: isLast ? 0 : 20 }}>
      <div style={{ width: 36, height: 36, borderRadius: '50%', backgroundColor: P.white, border: `2px solid ${P.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', flexShrink: 0, position: 'relative', zIndex: 1 }}>{icon}</div>
      <div style={{ paddingTop: 6, paddingBottom: 8, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
          <span style={{ fontWeight: 600, color: P.dark, fontSize: '0.9rem' }}>{ev.title || ev.event_type.replace(/_/g, ' ')}</span>
          {ev.quantity && <span style={{ fontSize: '0.78rem', color: P.mid, backgroundColor: P.greenPale, borderRadius: 10, padding: '1px 8px' }}>{ev.quantity}</span>}
          <span style={{ fontSize: '0.75rem', color: P.light, marginLeft: 'auto' }}>{formatDate(ev.event_date)}</span>
        </div>
        {ev.notes && <p style={{ margin: 0, color: P.mid, fontSize: '0.85rem', lineHeight: 1.5 }}>{ev.notes}</p>}
      </div>
    </div>
  )
}

function StatusBadge({ status }) {
  const colors = { planning:{bg:'#fff8e6',text:'#7a5c00',border:'#c9a84c'}, active:{bg:'#d8f3dc',text:'#2d6a4f',border:'#52b788'}, harvested:{bg:'#eee',text:'#4a4a4a',border:'#d4c9be'}, ended:{bg:'#eee',text:'#777',border:'#d4c9be'} }
  const c = colors[status] ?? colors.planning
  return <span style={{ backgroundColor: c.bg, color: c.text, border: `1px solid ${c.border}`, fontSize: '0.75rem', padding: '3px 10px', borderRadius: 12, fontWeight: 600 }}>{status}</span>
}

function Page({ children }) {
  return <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>{children}</div>
}

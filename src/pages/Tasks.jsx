// TODO DB-MIGRATE-TASKS: migrate to /api/tasks Lambda when deployed
import { Link } from 'react-router-dom'
import { P } from '../lib/constants.js'

// ============================================================
// Tasks — Coming Soon (V2)
//
// Full Tasks implementation (ADHD-aware task cards, zone picker,
// overdue/today/upcoming sections, priority badges) is complete
// and preserved below as TasksV2. It will be wired back in once
// the Supabase tasks table is ready for production and the UI
// has been through a UX review.
// ============================================================

// Coming Soon placeholder removed — TasksV2 is now active below


// ============================================================
// V2 IMPLEMENTATION — preserved, not exported
// Restore by: export default TasksV2 (replace export above)
// ============================================================

import { useState, useEffect, useCallback } from 'react'
import { TASK_PRIORITIES } from '../lib/constants.js'

const OVERDUE_DISPLAY_CAP = 3

export default function TasksV2() {
  const [tasks,      setTasks]      = useState([])
  const [locations,  setLocations]  = useState([])
  const [projects,   setProjects]   = useState([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)
  const [showForm,   setShowForm]   = useState(false)
  const [statusFilter, setFilter]   = useState('pending')
  const [overdueExpanded, setOverdueExpanded] = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [formError,  setFormError]  = useState(null)
  const [form,       setForm]       = useState(emptyForm())

  function emptyForm() {
    return { title: '', description: '', due_date: '', due_time: '', priority: 'normal', location_id: '', project_id: '' }
  }

  const load = useCallback(async () => {
    setTasks([])
    setLocations([])
    setProjects([])
    setLoading(false)
  }, [statusFilter])

  useEffect(() => { load() }, [load])

  async function handleCreate(e) {
    e.preventDefault()
    setFormError('Task creation coming soon via /api/tasks Lambda.')
  }

  async function handleComplete() {}
  async function handleSkip()     {}
  async function handleReopen()   {}

  const today = new Date().toISOString().split('T')[0]
  const overdue  = tasks.filter(t => t.due_date && t.due_date < today)
  const dueToday = tasks.filter(t => t.due_date === today)
  const upcoming = tasks.filter(t => !t.due_date || t.due_date > today)
  const overdueVisible = overdueExpanded ? overdue : overdue.slice(0, OVERDUE_DISPLAY_CAP)
  const locMap = Object.fromEntries(locations.map(l => [l.id, l.full_path]))

  if (loading) return <Shell><div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div></Shell>
  if (error)   return <Shell><div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{error}</div></Shell>

  return (
    <Shell>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Tasks</h1>
          <p style={{ margin: '4px 0 0', color: P.light, fontSize: '0.85rem' }}>{tasks.length} {statusFilter} · {overdue.length > 0 ? `${overdue.length} overdue` : 'none overdue'}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <FilterBar value={statusFilter} onChange={v => { setFilter(v); setLoading(true) }} />
          {statusFilter === 'pending' && <button onClick={() => { setShowForm(s => !s); setFormError(null); setForm(emptyForm()) }} style={btn(P.green)}>{showForm ? 'Cancel' : '+ Add task'}</button>}
        </div>
      </div>
      {showForm && <CreateFormV2 form={form} setForm={setForm} locations={locations} projects={projects} saving={saving} formError={formError} onSubmit={handleCreate} />}
      {statusFilter === 'pending' && overdue.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <SectionHead label={`⚠️ Overdue · ${overdue.length}`} color={P.terra} />
          {overdueVisible.map(t => <TaskCard key={t.id} task={t} urgency="overdue" locMap={locMap} onComplete={handleComplete} onSkip={handleSkip} />)}
          {overdue.length > OVERDUE_DISPLAY_CAP && <button onClick={() => setOverdueExpanded(x => !x)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.mid, fontSize: '0.8rem', padding: '6px 0', textDecoration: 'underline' }}>{overdueExpanded ? 'Show fewer' : `See all overdue (${overdue.length - OVERDUE_DISPLAY_CAP} more)`}</button>}
        </section>
      )}
      {statusFilter === 'pending' && dueToday.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <SectionHead label={`📅 Due today · ${dueToday.length}`} color={P.gold} />
          {dueToday.map(t => <TaskCard key={t.id} task={t} urgency="today" locMap={locMap} onComplete={handleComplete} onSkip={handleSkip} />)}
        </section>
      )}
      {(statusFilter !== 'pending' ? tasks : upcoming).length > 0 ? (
        <section style={{ marginBottom: 24 }}>
          {statusFilter === 'pending' && <SectionHead label={`Upcoming · ${upcoming.length}`} color={P.mid} />}
          {(statusFilter !== 'pending' ? tasks : upcoming).map(t => <TaskCard key={t.id} task={t} urgency="normal" locMap={locMap} onComplete={handleComplete} onSkip={handleSkip} onReopen={statusFilter !== 'pending' ? handleReopen : undefined} />)}
        </section>
      ) : (statusFilter === 'pending' && overdue.length === 0 && dueToday.length === 0 && <div style={{ textAlign: 'center', color: P.light, padding: '40px 20px', fontSize: '0.875rem', backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 8 }}>No tasks yet. Hit '+ Add task' to create one.</div>)}
    </Shell>
  )
}

function CreateFormV2({ form, setForm, locations, projects, saving, formError, onSubmit }) {
  return (
    <form onSubmit={onSubmit} style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 24, marginBottom: 24 }}>
      <h2 style={{ margin: '0 0 18px', fontSize: '1rem', fontWeight: 700, color: P.dark }}>New task</h2>
      {formError && <div role="alert" style={{ backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: '0.875rem', color: '#7a2a10' }}>{formError}</div>}
      <div style={{ marginBottom: 14 }}>
        <label htmlFor="task-title" style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: P.mid, marginBottom: 5 }}>Title *</label>
        <input id="task-title" required value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} style={{ width: '100%', padding: '8px 11px', border: `1px solid ${P.border}`, borderRadius: 6, fontSize: '0.88rem', backgroundColor: P.white, boxSizing: 'border-box' }} placeholder="e.g. Water pepper seedlings" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ marginBottom: 14 }}>
          <label htmlFor="task-due-date" style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: P.mid, marginBottom: 5 }}>Due date</label>
          <input id="task-due-date" type="date" value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} style={{ width: '100%', padding: '8px 11px', border: `1px solid ${P.border}`, borderRadius: 6, fontSize: '0.88rem', backgroundColor: P.white, boxSizing: 'border-box' }} />
        </div>
        <div style={{ marginBottom: 14 }}>
          <label htmlFor="task-priority" style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: P.mid, marginBottom: 5 }}>Priority</label>
          <select id="task-priority" value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))} style={{ width: '100%', padding: '8px 11px', border: `1px solid ${P.border}`, borderRadius: 6, fontSize: '0.88rem', backgroundColor: P.white, boxSizing: 'border-box' }}>{TASK_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}</select>
        </div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <label htmlFor="task-location" style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: P.mid, marginBottom: 5 }}>Location</label>
        <select id="task-location" value={form.location_id} onChange={e => setForm(f => ({ ...f, location_id: e.target.value }))} style={{ width: '100%', padding: '8px 11px', border: `1px solid ${P.border}`, borderRadius: 6, fontSize: '0.88rem', backgroundColor: P.white, boxSizing: 'border-box' }}><option value="">— No location —</option>{locations.map(l => <option key={l.id} value={l.id}>{l.full_path}</option>)}</select>
      </div>
      <div style={{ marginBottom: 14 }}>
        <label htmlFor="task-project" style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: P.mid, marginBottom: 5 }}>Project (optional)</label>
        <select id="task-project" value={form.project_id} onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))} style={{ width: '100%', padding: '8px 11px', border: `1px solid ${P.border}`, borderRadius: 6, fontSize: '0.88rem', backgroundColor: P.white, boxSizing: 'border-box' }}><option value="">— Not linked —</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </div>
      <div style={{ marginBottom: 14 }}>
        <label htmlFor="task-notes" style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: P.mid, marginBottom: 5 }}>Notes (optional)</label>
        <textarea id="task-notes" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} style={{ width: '100%', padding: '8px 11px', border: `1px solid ${P.border}`, borderRadius: 6, fontSize: '0.88rem', backgroundColor: P.white, boxSizing: 'border-box', minHeight: 64, resize: 'vertical' }} placeholder="Any details…" />
      </div>
      <div style={{ marginTop: 20 }}>
        <button type="submit" disabled={saving} style={{ backgroundColor: saving ? P.light : P.green, color: P.white, border: 'none', borderRadius: 6, padding: '9px 18px', fontSize: '0.88rem', fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer' }}>{saving ? 'Saving…' : 'Create task'}</button>
      </div>
    </form>
  )
}

function TaskCard({ task, urgency, locMap, onComplete, onSkip, onReopen }) {
  const isPending = !onReopen
  const s = { overdue: { bg: '#fde8e0', border: P.terra, labelColor: P.terra }, today: { bg: P.warn, border: P.gold, labelColor: '#7a5c00' }, normal: { bg: P.white, border: P.border, labelColor: P.mid } }[urgency] ?? { bg: P.white, border: P.border, labelColor: P.mid }
  return (
    <div style={{ backgroundColor: s.bg, border: `1px solid ${s.border}`, borderRadius: 8, padding: '12px 16px', marginBottom: 8, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, color: P.dark, fontSize: '0.92rem' }}>{task.title}</span>
          {task.priority !== 'normal' && <span style={{ fontSize: '0.7rem', fontWeight: 600, backgroundColor: task.priority === 'high' ? '#fde8e0' : '#f0f0f0', color: task.priority === 'high' ? P.terra : P.light, border: `1px solid ${task.priority === 'high' ? P.alertBorder : '#ccc'}`, borderRadius: 10, padding: '1px 7px' }}>{task.priority === 'high' ? '↑ high' : '↓ low'}</span>}
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 4, flexWrap: 'wrap' }}>
          {task.due_date && <span style={{ fontSize: '0.78rem', color: s.labelColor }}>{urgency === 'overdue' ? '⚠️' : urgency === 'today' ? '📅' : '🗓'} {task.due_date}</span>}
          {task.location_id && locMap[task.location_id] && <span style={{ fontSize: '0.78rem', color: P.mid }}>📍 {locMap[task.location_id]}</span>}
          {task.completed_at && <span style={{ fontSize: '0.78rem', color: P.light }}>✓ {new Date(task.completed_at).toLocaleDateString()}</span>}
        </div>
        {task.description && <p style={{ margin: '6px 0 0', fontSize: '0.82rem', color: P.mid, lineHeight: 1.4 }}>{task.description}</p>}
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {isPending ? (
          <><button onClick={() => onComplete(task)} style={{ background: 'none', border: `1px solid ${P.green}`, color: P.green, borderRadius: 6, padding: '8px 14px', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', minHeight: 44 }}>Done ✓</button><button onClick={() => onSkip(task)} style={{ background: 'none', border: `1px solid ${P.light}`, color: P.light, borderRadius: 6, padding: '8px 14px', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', minHeight: 44 }}>Skip</button></>
        ) : (
          <button onClick={() => onReopen(task)} style={{ background: 'none', border: `1px solid ${P.mid}`, color: P.mid, borderRadius: 6, padding: '8px 14px', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', minHeight: 44 }}>Reopen</button>
        )}
      </div>
    </div>
  )
}

function FilterBar({ value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 4, backgroundColor: P.border, borderRadius: 6, padding: 3 }}>
      {[{ v: 'pending', label: 'Pending' }, { v: 'done', label: 'Done' }, { v: 'skipped', label: 'Skipped' }].map(o => (
        <button key={o.v} onClick={() => onChange(o.v)} style={{ background: value === o.v ? P.white : 'none', border: 'none', borderRadius: 4, padding: '4px 12px', fontSize: '0.8rem', fontWeight: value === o.v ? 600 : 400, color: value === o.v ? P.dark : P.mid, cursor: 'pointer' }}>{o.label}</button>
      ))}
    </div>
  )
}

function SectionHead({ label, color }) {
  return <h2 style={{ margin: '0 0 10px', fontSize: '0.85rem', fontWeight: 700, color: color ?? P.mid, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</h2>
}

function Shell({ children }) {
  return <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}><div style={{ maxWidth: 800, margin: '0 auto', padding: '32px 20px' }}>{children}</div></div>
}

const btn = (bg) => ({ backgroundColor: bg, color: P.white, border: 'none', borderRadius: 6, padding: '9px 18px', fontSize: '0.88rem', fontWeight: 600, cursor: bg === P.light ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' })


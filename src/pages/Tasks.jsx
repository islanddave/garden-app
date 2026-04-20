import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { P, TASK_PRIORITIES } from '../lib/constants.js'

// ============================================================
// Tasks — Layer 3: Manual zone picker
//
// LOC-006 PROVISIONAL DECISION (2026-04-20):
//   Task completion is household-shared. assigned_to is set null on
//   create (any household member can complete any task).
// ============================================================

const OVERDUE_DISPLAY_CAP = 3

export default function Tasks() {
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
    const [
      { data: taskData,  error: tErr },
      { data: locData,   error: lErr },
      { data: projData,  error: pErr },
    ] = await Promise.all([
      supabase.from('tasks').select('id, title, description, due_date, due_time, priority, status, completed_at, assigned_to, location_id, project_id').eq('status', statusFilter).order('due_date', { ascending: true, nullsFirst: false }),
      supabase.from('locations_with_path').select('id, full_path, level, is_active').eq('is_active', true).order('full_path'),
      supabase.from('plant_projects').select('id, name').in('status', ['planning', 'active']).order('name'),
    ])
    if (tErr || lErr || pErr) { setError((tErr || lErr || pErr).message) }
    else { setTasks(taskData ?? []); setLocations(locData ?? []); setProjects(projData ?? []) }
    setLoading(false)
  }, [statusFilter])

  useEffect(() => { load() }, [load])

  async function handleCreate(e) {
    e.preventDefault()
    setSaving(true); setFormError(null)
    const { error } = await supabase.from('tasks').insert({
      title: form.title.trim(), description: form.description.trim() || null,
      due_date: form.due_date || null, due_time: form.due_time || null,
      priority: form.priority, location_id: form.location_id || null,
      project_id: form.project_id || null, assigned_to: null,
    })
    setSaving(false)
    if (error) { setFormError(error.message) }
    else { setForm(emptyForm()); setShowForm(false); load() }
  }

  async function handleComplete(task) {
    await supabase.from('tasks').update({ status: 'done', completed_at: new Date().toISOString() }).eq('id', task.id)
    load()
  }
  async function handleSkip(task) {
    await supabase.from('tasks').update({ status: 'skipped' }).eq('id', task.id)
    load()
  }
  async function handleReopen(task) {
    await supabase.from('tasks').update({ status: 'pending', completed_at: null }).eq('id', task.id)
    load()
  }

  const today = new Date().toISOString().split('T')[0]
  const overdue  = tasks.filter(t => t.due_date && t.due_date < today)
  const dueToday = tasks.filter(t => t.due_date === today)
  const upcoming = tasks.filter(t => !t.due_date || t.due_date > today)
  const overdueVisible = overdueExpanded ? overdue : overdue.slice(0, OVERDUE_DISPLAY_CAP)
  const locMap = Object.fromEntries(locations.map(l => [l.id, l.full_path]))

  if (loading) return <Shell><Spinner /></Shell>
  if (error)   return <Shell><ErrMsg msg={error} /></Shell>

  return (
    <Shell>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Tasks</h1>
          <p style={{ margin: '4px 0 0', color: P.light, fontSize: '0.85rem' }}>
            {tasks.length} {statusFilter} · {overdue.length > 0 ? `${overdue.length} overdue` : 'none overdue'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <FilterBar value={statusFilter} onChange={v => { setFilter(v); setLoading(true) }} />
          {statusFilter === 'pending' && (
            <button onClick={() => { setShowForm(s => !s); setFormError(null); setForm(emptyForm()) }} style={btn(P.green)}>
              {showForm ? 'Cancel' : '+ Add task'}
            </button>
          )}
        </div>
      </div>

      {showForm && (
        <CreateForm form={form} setForm={setForm} locations={locations} projects={projects} saving={saving} formError={formError} onSubmit={handleCreate} />
      )}

      {statusFilter === 'pending' && overdue.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <SectionHead label={`⚠️ Overdue · ${overdue.length}`} color={P.terra} />
          {overdueVisible.map(t => <TaskCard key={t.id} task={t} urgency="overdue" locMap={locMap} onComplete={handleComplete} onSkip={handleSkip} />)}
          {overdue.length > OVERDUE_DISPLAY_CAP && (
            <button onClick={() => setOverdueExpanded(x => !x)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.mid, fontSize: '0.8rem', padding: '6px 0', textDecoration: 'underline' }}>
              {overdueExpanded ? 'Show fewer' : `See all overdue (${overdue.length - OVERDUE_DISPLAY_CAP} more)`}
            </button>
          )}
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
          {(statusFilter !== 'pending' ? tasks : upcoming).map(t => (
            <TaskCard key={t.id} task={t} urgency="normal" locMap={locMap} onComplete={handleComplete} onSkip={handleSkip} onReopen={statusFilter !== 'pending' ? handleReopen : undefined} />
          ))}
        </section>
      ) : (
        statusFilter === 'pending' && overdue.length === 0 && dueToday.length === 0 && <Empty msg="No tasks yet. Hit '+ Add task' to create one." />
      )}
    </Shell>
  )
}

function CreateForm({ form, setForm, locations, projects, saving, formError, onSubmit }) {
  return (
    <form onSubmit={onSubmit} style={card}>
      <h2 style={{ margin: '0 0 18px', fontSize: '1rem', fontWeight: 700, color: P.dark }}>New task</h2>
      {formError && <ErrBanner msg={formError} />}
      <FormRow label="Title *"><input required value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} style={input} placeholder="e.g. Water pepper seedlings" /></FormRow>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <FormRow label="Due date"><input type="date" value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} style={{ ...input, width: '100%' }} /></FormRow>
        <FormRow label="Priority"><select value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))} style={{ ...input, width: '100%' }}>{TASK_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}</select></FormRow>
      </div>
      <FormRow label="Location (manual zone picker)">
        <select value={form.location_id} onChange={e => setForm(f => ({ ...f, location_id: e.target.value }))} style={input}>
          <option value="">— No location —</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.full_path}</option>)}
        </select>
      </FormRow>
      <FormRow label="Project (optional)">
        <select value={form.project_id} onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))} style={input}>
          <option value="">— Not linked to a project —</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </FormRow>
      <FormRow label="Notes (optional)"><textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} style={{ ...input, minHeight: 64, resize: 'vertical' }} placeholder="Any details…" /></FormRow>
      <div style={{ marginTop: 20 }}><button type="submit" disabled={saving} style={btn(saving ? P.light : P.green)}>{saving ? 'Saving…' : 'Create task'}</button></div>
    </form>
  )
}

function TaskCard({ task, urgency, locMap, onComplete, onSkip, onReopen }) {
  const isPending = !onReopen
  const urgencyStyles = { overdue:{bg:'#fde8e0',border:P.terra,labelColor:P.terra}, today:{bg:P.warn,border:P.gold,labelColor:'#7a5c00'}, normal:{bg:P.white,border:P.border,labelColor:P.mid} }
  const s = urgencyStyles[urgency] ?? urgencyStyles.normal
  return (
    <div style={{ backgroundColor: s.bg, border: `1px solid ${s.border}`, borderRadius: 8, padding: '12px 16px', marginBottom: 8, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, color: P.dark, fontSize: '0.92rem' }}>{task.title}</span>
          <PriorityBadge priority={task.priority} />
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 4, flexWrap: 'wrap' }}>
          {task.due_date && <span style={{ fontSize: '0.78rem', color: s.labelColor }}>{urgency==='overdue'?'⚠️':urgency==='today'?'📅':'🗓'} {task.due_date}</span>}
          {task.location_id && locMap[task.location_id] && <span style={{ fontSize: '0.78rem', color: P.mid }}>📍 {locMap[task.location_id]}</span>}
          {task.completed_at && <span style={{ fontSize: '0.78rem', color: P.light }}>✓ {new Date(task.completed_at).toLocaleDateString()}</span>}
        </div>
        {task.description && <p style={{ margin: '6px 0 0', fontSize: '0.82rem', color: P.mid, lineHeight: 1.4 }}>{task.description}</p>}
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {isPending ? (
          <><button onClick={() => onComplete(task)} style={actionBtn(P.green)}>Done ✓</button><button onClick={() => onSkip(task)} style={actionBtn(P.light)}>Skip</button></>
        ) : (
          <button onClick={() => onReopen(task)} style={actionBtn(P.mid)}>Reopen</button>
        )}
      </div>
    </div>
  )
}

function PriorityBadge({ priority }) {
  if (priority === 'normal') return null
  const styles = { high:{bg:'#fde8e0',color:P.terra,border:P.alertBorder,label:'↑ high'}, low:{bg:'#f0f0f0',color:P.light,border:'#ccc',label:'↓ low'} }
  const s = styles[priority]
  if (!s) return null
  return <span style={{ fontSize: '0.7rem', fontWeight: 600, backgroundColor: s.bg, color: s.color, border: `1px solid ${s.border}`, borderRadius: 10, padding: '1px 7px' }}>{s.label}</span>
}

function FilterBar({ value, onChange }) {
  const opts = [{v:'pending',label:'Pending'},{v:'done',label:'Done'},{v:'skipped',label:'Skipped'}]
  return (
    <div style={{ display: 'flex', gap: 4, backgroundColor: P.border, borderRadius: 6, padding: 3 }}>
      {opts.map(o => <button key={o.v} onClick={() => onChange(o.v)} style={{ background: value===o.v?P.white:'none', border:'none', borderRadius:4, padding:'4px 12px', fontSize:'0.8rem', fontWeight:value===o.v?600:400, color:value===o.v?P.dark:P.mid, cursor:'pointer' }}>{o.label}</button>)}
    </div>
  )
}

function SectionHead({ label, color }) {
  return <h2 style={{ margin:'0 0 10px', fontSize:'0.85rem', fontWeight:700, color:color??P.mid, textTransform:'uppercase', letterSpacing:'0.5px' }}>{label}</h2>
}

function Shell({ children }) {
  return <div style={{ minHeight:'calc(100vh - 52px)', backgroundColor:P.cream }}><div style={{ maxWidth:800, margin:'0 auto', padding:'32px 20px' }}>{children}</div></div>
}
function Spinner() { return <div style={{ padding:48, textAlign:'center', color:P.light }}>Loading…</div> }
function ErrMsg({ msg }) { return <div style={{ padding:48, textAlign:'center', color:P.terra }}>{msg}</div> }
function ErrBanner({ msg }) { return <div style={{ backgroundColor:P.alert, border:`1px solid ${P.alertBorder}`, borderRadius:6, padding:'10px 14px', marginBottom:16, fontSize:'0.875rem', color:'#7a2a10' }}>{msg}</div> }
function Empty({ msg }) { return <div style={{ textAlign:'center', color:P.light, padding:'40px 20px', fontSize:'0.875rem', backgroundColor:P.white, border:`1px solid ${P.border}`, borderRadius:8 }}>{msg}</div> }
function FormRow({ label, children }) { return <div style={{ marginBottom:14 }}><label style={{ display:'block', fontSize:'0.8rem', fontWeight:600, color:P.mid, marginBottom:5 }}>{label}</label>{children}</div> }

const btn = (bg) => ({ backgroundColor:bg, color:P.white, border:'none', borderRadius:6, padding:'9px 18px', fontSize:'0.88rem', fontWeight:600, cursor:bg===P.light?'not-allowed':'pointer', whiteSpace:'nowrap' })
const actionBtn = (color) => ({ background:'none', border:`1px solid ${color}`, color:color, borderRadius:5, padding:'4px 11px', fontSize:'0.8rem', fontWeight:600, cursor:'pointer', whiteSpace:'nowrap' })
const input = { width:'100%', padding:'8px 11px', border:`1px solid ${P.border}`, borderRadius:6, fontSize:'0.88rem', backgroundColor:P.white, boxSizing:'border-box' }
const card = { backgroundColor:P.white, border:`1px solid ${P.border}`, borderRadius:10, padding:24, marginBottom:24 }

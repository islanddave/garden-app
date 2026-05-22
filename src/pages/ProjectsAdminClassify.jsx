// V1.2a-4 S6 (PROJ-RESCOPE) — admin classify route.
// Backfills plant_projects.kind for 18 alive rows. Desktop-only. Jen-invisible.
// Per design proj-rescope-s6-design-V001-20260519.1625.md §5.3 + §5.4.
//
// Surfaces:
//   - Desktop-only viewport guard (≥1024px). Placard otherwise.
//   - GET /api/projects?admin=1 — all alive rows regardless of ownership.
//   - Per-row kind dropdown (campaign | category | cultivar | defer).
//   - Cultivar row reveals inline variety-name input.
//   - Save-per-row: POST /api/varieties (cultivar only, idempotent on
//     source_proj_rescope_project_id) → PATCH /api/projects/:id with kind.
//   - Progress bar X of N.
//   - When all classified: copy-ready apply-prod-migrations
//     command (Dave runs from terminal — no in-app DDL surface).

import React, { useState, useEffect, useCallback } from 'react'
import { useApiFetch } from '../lib/api.js'

const KIND_OPTIONS = [
  { value: '', label: '— pick —' },
  { value: 'campaign', label: 'Campaign (growing this season)' },
  { value: 'category', label: 'Category (folder for organizing)' },
  { value: 'cultivar', label: 'Cultivar (variety reference)' },
]

const MIGRATE_CMD = 'python3 claude-ops/scripts/apply-prod-migrations.py --target prod --mig-dir claude-ops/scripts/proj-rescope/s6-0a'

export default function ProjectsAdminClassify() {
  const [isDesktop, setIsDesktop] = useState(
    () => (typeof window !== 'undefined' ? window.innerWidth >= 1024 : true)
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = () => setIsDesktop(window.innerWidth >= 1024)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const { fetch } = useApiFetch()
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // per-row local state: { [id]: { kind?, varietyName?, saving?, saved?, error? } }
  const [rowState, setRowState] = useState({})

  const loadProjects = useCallback(() => {
    setLoading(true)
    setError(null)
    fetch('/api/projects?admin=1')
      .then((data) => {
        setProjects(data ?? [])
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message ?? String(err))
        setLoading(false)
      })
  }, [fetch])

  useEffect(() => { loadProjects() }, [loadProjects])

  if (!isDesktop) return <DesktopOnlyPlacard />
  if (loading) return <Shell><p>Loading…</p></Shell>
  if (error) return <Shell><p style={{ color: '#b94a3a' }}>Error: {error}</p></Shell>

  const byId = {}
  projects.forEach((p) => { byId[p.id] = p })

  const depthOf = (p) => {
    let d = 0
    let cur = p
    let safety = 0
    while (cur.parent_project_id && byId[cur.parent_project_id] && safety < 12) {
      cur = byId[cur.parent_project_id]
      d++
      safety++
    }
    return d
  }

  const breadcrumbOf = (p) => {
    const parts = []
    let cur = p
    let safety = 0
    while (cur.parent_project_id && byId[cur.parent_project_id] && safety < 12) {
      cur = byId[cur.parent_project_id]
      parts.unshift(cur.name)
      safety++
    }
    return parts
  }

  const sorted = [...projects].sort((a, b) => {
    const da = depthOf(a)
    const db = depthOf(b)
    if (da !== db) return da - db
    return a.name.localeCompare(b.name)
  })

  const classified = projects.filter((p) => p.kind != null).length
  const total = projects.length
  const allDone = total > 0 && classified === total

  const setRowKind = (id, kind) =>
    setRowState((s) => ({ ...s, [id]: { ...s[id], kind, saved: false, error: null } }))
  const setVarietyName = (id, name) =>
    setRowState((s) => ({ ...s, [id]: { ...s[id], varietyName: name } }))

  async function saveRow(p) {
    const st = rowState[p.id] ?? {}
    if (!st.kind) return
    setRowState((s) => ({ ...s, [p.id]: { ...st, saving: true, error: null } }))
    try {
      if (st.kind === 'cultivar') {
        const varietyName = (st.varietyName ?? p.name).trim()
        if (!varietyName) {
          setRowState((s) => ({ ...s, [p.id]: { ...st, saving: false, error: 'Variety name required' } }))
          return
        }
        await fetch('/api/varieties', {
          method: 'POST',
          body: JSON.stringify({ name: varietyName, source_proj_rescope_project_id: p.id }),
        })
      }
      await fetch(`/api/projects/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ kind: st.kind }),
      })
      setRowState((s) => ({ ...s, [p.id]: { ...st, saving: false, saved: true } }))
      loadProjects()
    } catch (err) {
      setRowState((s) => ({ ...s, [p.id]: { ...st, saving: false, error: err.message ?? String(err) } }))
    }
  }

  return (
    <Shell>
      <h1 style={{ marginTop: 0, fontSize: '1.4rem' }}>Admin Classify — plant_projects.kind</h1>
      <p style={{ color: '#666', marginBottom: 4 }}>
        Desktop-only admin surface. Backfills the <code>kind</code> column on every alive plant_projects row, then runs the <code>NOT NULL</code> CHECK constraint migration.
      </p>
      <p style={{ color: '#666', marginTop: 0 }}>
        {classified} of {total} classified.
      </p>
      <ProgressBar n={classified} total={total} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 20 }}>
        {sorted.map((p) => (
          <RowCard
            key={p.id}
            project={p}
            depth={depthOf(p)}
            breadcrumb={breadcrumbOf(p)}
            rowState={rowState[p.id] ?? {}}
            onKindChange={(k) => setRowKind(p.id, k)}
            onVarietyName={(n) => setVarietyName(p.id, n)}
            onSave={() => saveRow(p)}
          />
        ))}
      </div>

      {allDone ? (
        <ReadyToMigrateBlock />
      ) : (
        <PendingMigrationBlock
          classified={classified}
          total={total}
        />
      )}
    </Shell>
  )
}

function Shell({ children }) {
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 1100, margin: '0 auto' }}>
      {children}
    </div>
  )
}

function DesktopOnlyPlacard() {
  return (
    <div role="alert" style={{ padding: '48px 20px', textAlign: 'center', color: '#666' }}>
      <h2 style={{ marginTop: 0 }}>Desktop only</h2>
      <p>This admin tool needs a wider viewport (≥1024px). Reopen on a desktop browser.</p>
    </div>
  )
}

function ProgressBar({ n, total }) {
  const pct = total > 0 ? Math.round((n / total) * 100) : 0
  return (
    <div aria-label={`progress ${n} of ${total}`}
         style={{ height: 8, background: '#eee', borderRadius: 4, overflow: 'hidden', marginTop: 8 }}>
      <div style={{ height: '100%', width: `${pct}%`, background: '#4a7c59', transition: 'width 200ms ease' }} />
    </div>
  )
}

function RowCard({ project: p, depth, breadcrumb, rowState, onKindChange, onVarietyName, onSave }) {
  const isCultivar = rowState.kind === 'cultivar'
  const serverKind = p.kind
  const pickedKind = rowState.kind ?? ''
  const isDirty = pickedKind && pickedKind !== serverKind
  return (
    <div style={{
      padding: 12,
      paddingLeft: 12 + depth * 24,
      background: '#fff',
      border: '1px solid #ddd',
      borderRadius: 6,
      display: 'flex',
      alignItems: 'center',
      gap: 12,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{p.name}</div>
        {breadcrumb.length > 0 && (
          <div style={{ fontSize: '0.78rem', color: '#888' }}>
            {breadcrumb.join(' › ')}
          </div>
        )}
        {serverKind && (
          <div style={{ fontSize: '0.78rem', color: '#4a7c59' }}>
            Current: <strong>{serverKind}</strong>
          </div>
        )}
      </div>
      <select
        aria-label={`kind for ${p.name}`}
        value={pickedKind}
        onChange={(e) => onKindChange(e.target.value)}
        style={{ padding: '6px 8px', borderRadius: 4, border: '1px solid #bbb', fontSize: '0.9rem' }}
      >
        {KIND_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {isCultivar && (
        <input
          type="text"
          placeholder={`variety name (default: ${p.name})`}
          aria-label={`variety name for ${p.name}`}
          value={rowState.varietyName ?? ''}
          onChange={(e) => onVarietyName(e.target.value)}
          style={{ padding: '6px 8px', borderRadius: 4, border: '1px solid #bbb', fontSize: '0.9rem', width: 200 }}
        />
      )}
      <button
        type="button"
        onClick={onSave}
        disabled={!isDirty || rowState.saving}
        style={{
          padding: '6px 14px',
          borderRadius: 4,
          border: 'none',
          cursor: isDirty && !rowState.saving ? 'pointer' : 'not-allowed',
          background: isDirty && !rowState.saving ? '#4a7c59' : '#ccc',
          color: '#fff',
          fontSize: '0.9rem',
        }}
      >
        {rowState.saving ? 'Saving…' : rowState.saved ? 'Saved' : 'Save'}
      </button>
      {rowState.error && (
        <span role="alert" style={{ color: '#b94a3a', fontSize: '0.8rem' }}>{rowState.error}</span>
      )}
    </div>
  )
}

function PendingMigrationBlock({ classified, total }) {
  return (
    <div style={{ marginTop: 24, padding: 16, background: '#fffbe5', border: '1px solid #e0d090', borderRadius: 6 }}>
      <strong>Migration not yet runnable.</strong>
      <p style={{ marginBottom: 0, fontSize: '0.9rem' }}>
        Need {total - classified} more row(s) classified.
      </p>
    </div>
  )
}

function ReadyToMigrateBlock() {
  return (
    <div style={{ marginTop: 24, padding: 16, background: '#eaf5e9', border: '1px solid #4a7c59', borderRadius: 6 }}>
      <strong style={{ color: '#4a7c59' }}>Ready to migrate.</strong>
      <p style={{ marginBottom: 8, fontSize: '0.9rem' }}>
        All rows classified. Run from your terminal:
      </p>
      <pre style={{
        background: '#111',
        color: '#eee',
        padding: 12,
        borderRadius: 4,
        fontSize: '0.85rem',
        overflowX: 'auto',
        margin: 0,
      }}>
        {MIGRATE_CMD}
      </pre>
    </div>
  )
}

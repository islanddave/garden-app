import React, { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { getStatusColors } from '../lib/status.js'
import FavoriteToggle from '../components/FavoriteToggle.jsx'
import { buildDisplayList, loadSortOrder, saveSortOrder } from '../lib/projectTree.js'
import SortToggle from '../components/SortToggle.jsx'

// I7 fix (2026-05-18, V1.2a-3 Increment C / PR-C2): STATUS_COLORS now sourced from
// src/lib/status.js. The inline map here only covered {planning,active,harvested,ended},
// so growing/sprouting/flowering/fruiting fell through to `planning` (gold) — while
// Dashboard rendered them green. Symptom: same project's badge color flipped between surfaces.

// V3-ORDER-001 (Lane C / PR1): the local buildDisplayList copy was deleted and this surface now
// imports the shared util from projectTree.js. Previously ProjectList carried its OWN verbatim
// copy (the source comment in projectTree.js says it was "lifted from ProjectList.jsx") — two
// independent copies meant the alpha-sort would only land on whichever one was edited, breaking
// cross-surface ordering parity. Consolidated to the single shared implementation.

export default function ProjectList() {
  const { fetch } = useApiFetch()
  const [projects, setProjects] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)
  // V3-ORDER-001: persisted sort order. DEFAULT = recency; 'alpha' is opt-in.
  const [sortOrder, setSortOrder] = useState(() => loadSortOrder())
  const onSortChange = useCallback((order) => { setSortOrder(order); saveSortOrder(order) }, [])

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

  const displayList = buildDisplayList(projects, sortOrder)

  return (
    <Shell>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Projects</h1>
        <SortToggle order={sortOrder} onChange={onSortChange} label="Sort projects" />
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
  const sc = getStatusColors(p.status)
  // V1.2a-3 I6-glyph fix (2026-05-15): replace the broken `└` pseudo-tree glyph
  // (rendered outside the card in a proportional font, looked like a literal
  // letter "L") with a clean left-border accent on child cards + larger indent
  // per depth level. Full accordion redesign is deferred to PROJ-NAV (V1.2b/V2).
  const indent = depth * 24
  const isChild = depth > 0
  return (
    <div style={{ paddingLeft: indent }}>
      <Link to={`/projects/${p.id}`} style={{ textDecoration: 'none', display: 'block' }}>
        <div style={{
          backgroundColor: P.white,
          border: `1px solid ${P.border}`,
          borderLeft: isChild ? `3px solid ${P.greenLight}` : `1px solid ${P.border}`,
          borderRadius: 8,
          padding: '14px 18px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          cursor: 'pointer',
          transition: 'border-color 0.15s',
        }}
          onMouseEnter={e => e.currentTarget.style.borderColor = P.greenLight}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = P.border
            if (isChild) e.currentTarget.style.borderLeftColor = P.greenLight
          }}
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

          {/* Favorite toggle — V1.2a-3 Increment A (I3-affordance): projects were the
              one favoritable entity type with no star control. FavoriteToggle's onClick
              does preventDefault + stopPropagation, so it sits inside the card's <Link>
              without hijacking the navigate tap target. */}
          <FavoriteToggle entityType="project" entityId={p.id} />

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

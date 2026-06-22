// InactiveProjects — /inactive route page (V1.2a-2 S3 W4, plan §D).
//
// Surfaces projects the dashboard considers inactive. Two sections:
//   - Active: rows where dismissed === false
//   - Dismissed: rows where dismissed === true, re-sorted CLIENT-SIDE by
//     dismissed_at DESC ("what did I just dismiss") — the server sorts by
//     last_event_at, so the dismissed subset is re-sorted here.
//
// Dismiss flow (plan §D "revised flow"):
//   Tapping "Dismiss" on an Active row optimistically moves it to the Dismissed
//   section in LOCAL PAGE STATE only — it does NOT call the hook's dismiss() yet.
//   An UndoToast shows for 5s. If the user clicks Undo within the window, the row
//   returns to Active and no POST fires. If the window elapses, THEN the hook's
//   dismiss(projectId) fires the actual POST.
//
// Restore (Dismissed rows): no affordance yet. A muted "coming soon" caption under the
// Dismissed header signposts it; restore-from-dismissed is a V1.2a-2.1 backlog item —
// there is no server un-dismiss endpoint yet, so no Restore button is shown.

import React, { useEffect, useState, useRef, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { P } from '../lib/constants.js'
import { useToast } from '../context/ToastContext.jsx'
import { useInactiveProjects } from '../hooks/useInactiveProjects.js'

const UNDO_WINDOW_MS = 5000

export default function InactiveProjects() {
  const { projects, loading, error, dismiss } = useInactiveProjects()
  const { showUndo, dismiss: dismissToast } = useToast()

  // Local-only dismiss overlay: project ids the user has dismissed in-page but
  // whose 5s undo window hasn't elapsed yet. These render in the Dismissed section
  // (with a local dismissed_at) but no POST has fired.
  const [pendingDismissed, setPendingDismissed] = useState({}) // { [id]: dismissed_at iso }
  // Tracks the project whose 5s undo window is currently open (used to commit the
  // previous pending dismiss when a new one starts). The toast itself is now rendered
  // by the GLOBAL provider via showUndo(); toastIdRef holds its id so a superseding
  // dismiss can clear the prior toast.
  const [undoState, setUndoState] = useState(null) // { projectId, projectName }
  const toastIdRef = useRef(null)

  // Timer handles, keyed so unmount cleanup can clear everything.
  const dismissTimerRef = useRef(null)

  // Clean up any pending timers on unmount so a dismiss/restore timer can't
  // fire after navigation away from the page.
  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    }
  }, [])

  function handleDismiss(project) {
    // Clear any in-flight undo window first (commit it immediately would be
    // surprising — instead we just replace; the prior timer is cleared so the
    // prior project's POST won't fire from this path. The prior project stays
    // in pendingDismissed and will simply never get a POST. To keep things
    // simple and predictable for the single-row test cases, we commit the
    // previous pending dismiss before starting a new one.
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = null
    }
    if (undoState) {
      // Commit the previous pending dismiss for real.
      dismiss(undoState.projectId)
    }

    // Clear any prior global toast still on screen (superseded by this dismiss).
    if (toastIdRef.current != null) { dismissToast(toastIdRef.current); toastIdRef.current = null }

    const dismissedAt = new Date().toISOString()
    setPendingDismissed(prev => ({ ...prev, [project.id]: dismissedAt }))
    setUndoState({ projectId: project.id, projectName: project.name })

    // Operational undo via the GLOBAL toast layer (replaces the retired local UndoToast).
    // The page's own UNDO_WINDOW_MS timer below remains the authority that fires the
    // actual dismiss POST on elapse; the toast's Undo button routes to handleUndo, which
    // cancels that timer. Both windows are UNDO_WINDOW_MS so they stay in lockstep.
    toastIdRef.current = showUndo({
      message: `Dismissed ${project.name}`,
      onUndo: handleUndo,
      duration: UNDO_WINDOW_MS,
    })

    dismissTimerRef.current = setTimeout(() => {
      dismissTimerRef.current = null
      setUndoState(null)
      toastIdRef.current = null
      // Window elapsed with no Undo — fire the actual POST.
      dismiss(project.id)
    }, UNDO_WINDOW_MS)
  }

  function handleUndo() {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = null
    }
    setUndoState(prev => {
      if (prev) {
        const id = prev.projectId
        setPendingDismissed(p => {
          const next = { ...p }
          delete next[id]
          return next
        })
      }
      return null
    })
    if (toastIdRef.current != null) { dismissToast(toastIdRef.current); toastIdRef.current = null }
  }

  // Build the two sections, applying the local pendingDismissed overlay.
  const { activeRows, dismissedRows } = useMemo(() => {
    const active = []
    const dismissed = []
    for (const p of projects) {
      const pendingAt = pendingDismissed[p.id]
      if (pendingAt) {
        // Locally dismissed (undo window open or elapsed) — show in Dismissed.
        dismissed.push({ ...p, dismissed: true, dismissed_at: pendingAt })
      } else if (p.dismissed) {
        dismissed.push(p)
      } else {
        active.push(p)
      }
    }
    // Dismissed section sorted CLIENT-SIDE by dismissed_at DESC.
    dismissed.sort((a, b) => {
      const av = a.dismissed_at ?? ''
      const bv = b.dismissed_at ?? ''
      return bv.localeCompare(av)
    })
    return { activeRows: active, dismissedRows: dismissed }
  }, [projects, pendingDismissed])

  if (loading) return (
    <div style={{ padding: '48px 20px', textAlign: 'center', color: P.mid }}>
      Loading…
    </div>
  )

  if (error) return (
    <div style={{ padding: '48px 20px', textAlign: 'center', color: P.terra }}>
      Error loading inactive projects: {error}
    </div>
  )

  const isEmpty = projects.length === 0

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream, position: 'relative' }}>
      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '32px 20px' }}>

        {/* Breadcrumb back to Dashboard */}
        <Link to="/dashboard" style={{
          display: 'inline-block',
          color: P.green,
          fontSize: '0.82rem',
          fontWeight: 600,
          textDecoration: 'none',
          marginBottom: 16,
        }}>
          ← Dashboard
        </Link>

        <h1 style={{ color: P.green, fontSize: '1.4rem', fontWeight: 700, margin: '0 0 4px' }}>
          Inactive projects
        </h1>
        <p style={{ color: P.light, fontSize: '0.875rem', margin: '0 0 24px' }}>
          Projects that haven't seen recent activity.
        </p>

        {isEmpty ? (
          <div style={{
            backgroundColor: P.white, border: `1px solid ${P.border}`,
            borderRadius: 10, padding: '48px 24px', textAlign: 'center',
          }}>
            <div style={{ fontSize: '3rem', marginBottom: 12 }}>🌿</div>
            <p style={{ margin: '0 0 6px', fontWeight: 700, color: P.dark, fontSize: '1rem' }}>
              No inactive projects
            </p>
            <p style={{ margin: 0, color: P.light, fontSize: '0.875rem' }}>
              Everything's getting attention — nice work.
            </p>
          </div>
        ) : (
          <>
            {/* Active section */}
            <section style={{ marginBottom: 32 }}>
              <h2 style={sectionHeadStyle}>Active</h2>
              {activeRows.length === 0 ? (
                <EmptySectionNote text="Nothing here right now." />
              ) : (
                activeRows.map(project => (
                  <ProjectRow key={project.id} project={project}>
                    <RowButton onClick={() => handleDismiss(project)} label="Dismiss" />
                  </ProjectRow>
                ))
              )}
            </section>

            {/* Dismissed section */}
            <section>
              <h2 style={sectionHeadStyle}>Dismissed</h2>
              {dismissedRows.length > 0 && (
                <p style={{ color: P.light, fontSize: '0.78rem', margin: '0 0 12px' }}>
                  Restoring dismissed projects isn't available yet.
                </p>
              )}
              {dismissedRows.length === 0 ? (
                <EmptySectionNote text="Nothing dismissed yet." />
              ) : (
                dismissedRows.map(project => (
                  <ProjectRow key={project.id} project={project} muted />
                ))
              )}
            </section>
          </>
        )}
      </div>

    </div>
  )
}

// ─── Project row ─────────────────────────────────────────────────────────────
function ProjectRow({ project, children, muted }) {
  return (
    <div style={{
      backgroundColor: P.white,
      border: `1px solid ${P.border}`,
      borderRadius: 8,
      padding: '14px 16px',
      marginBottom: 8,
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 12,
      opacity: muted ? 0.75 : 1,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: P.green, fontSize: '0.95rem' }}>
          {project.name}
        </div>
        <div style={{ fontSize: '0.72rem', color: P.light, marginTop: 2 }}>
          {project.variety ? `${project.variety} · ` : ''}
          {project.status}
          {' · '}
          {relativeActivity(project)}
        </div>
      </div>
      <div style={{ flexShrink: 0 }}>
        {children}
      </div>
    </div>
  )
}

function RowButton({ onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        minHeight: 44,
        padding: '8px 14px',
        background: 'transparent',
        border: `1px solid ${P.border}`,
        borderRadius: 6,
        color: P.mid,
        fontSize: '0.82rem',
        fontWeight: 600,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}

function EmptySectionNote({ text }) {
  return (
    <div style={{
      backgroundColor: P.white,
      border: `1px solid ${P.border}`,
      borderRadius: 8,
      padding: '20px 16px',
      textAlign: 'center',
      color: P.light,
      fontSize: '0.82rem',
    }}>
      {text}
    </div>
  )
}

// ─── Utilities ───────────────────────────────────────────────────────────────
// Relative date from last_event_at, falling back to last_harvested_at, then
// start_date. Format: < 7 days -> "N days ago"; 7-30 days -> "N weeks ago";
// > 30 days -> "Month YYYY". Null dates -> "no recent activity".
export function relativeActivity(project) {
  const dateStr = project.last_event_at ?? project.last_harvested_at ?? project.start_date ?? null
  if (!dateStr) return 'no recent activity'
  const then = new Date(dateStr).getTime()
  if (Number.isNaN(then)) return 'no recent activity'
  const days = Math.floor((Date.now() - then) / 86400000)
  if (days < 0) return 'just now'
  if (days < 7) {
    if (days === 0) return 'today'
    if (days === 1) return '1 day ago'
    return `${days} days ago`
  }
  if (days <= 30) {
    const weeks = Math.round(days / 7)
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`
  }
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

const sectionHeadStyle = {
  color: P.dark,
  fontSize: '0.95rem',
  fontWeight: 700,
  margin: '0 0 12px',
}

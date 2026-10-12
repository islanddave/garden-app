// src/pages/CropTypesAdmin.jsx — V4-CROPTYPERETIRE-001. Retire a crop type nothing uses, or bring
// one back. The one door to both, at /admin/crop-types (row in DebugMenu.jsx).
//
// WHO SEES IT. The server decides (ADMIN_CLERK_SUBS on the varieties Lambda, fail-closed); there is
// no client admin list, as on every /admin page. A non-admin who follows the Debug & smoke row gets
// the same neutral placard GardenActivity and AdminConfig show. One state is different on purpose:
// when the server says nobody could be the admin yet (the setting is not on this Lambda), the page
// says so in a plain line, because otherwise the admin sees a placard and cannot tell why.
//
// WHAT RETIRE DOES. The type leaves every picker. Nothing is deleted, and the server refuses while
// anything live still uses the type, so there is nothing to confirm: the result is printed in the row
// and Bring back is right there. No modal, no toast.
import React, { useCallback, useEffect, useState } from 'react'
import { P } from '../lib/constants.js'
import { useApiFetch } from '../lib/api.js'

export const NOT_SWITCHED_ON = "Retiring isn't switched on for this garden yet."
export const NOT_ADMIN_ACTION = "Only the garden's admin can do that."
export const UNREACHABLE = "Couldn't reach the garden. Try again."
const NOT_CONFIGURED_CODE = 'admin_not_configured'

const card = {
  background: P.white, border: `1px solid ${P.border}`, borderRadius: 10,
  padding: '10px 14px', marginBottom: 8,
}
const heading = {
  fontSize: '0.78rem', fontWeight: 700, color: P.light, letterSpacing: '0.05em',
  textTransform: 'uppercase', margin: '20px 0 8px',
}
const button = {
  flexShrink: 0, minHeight: 44, minWidth: 96, padding: '0 14px', borderRadius: 8,
  border: `1px solid ${P.border}`, background: P.cream, color: P.dark,
  fontSize: '0.95rem', fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
}

function NeutralPlacard() {
  return (
    <div role="status" style={{ padding: '48px 20px', textAlign: 'center', color: P.light }}>
      <p>Nothing to see here.</p>
    </div>
  )
}

function Shell({ children }) {
  return <div style={{ padding: 16, paddingBottom: 40, maxWidth: 640, margin: '0 auto' }}>{children}</div>
}

// The words for a refused or failed retire / bring back. The server's own sentences are plain
// ("Still used by 3 pantry items and 1 batch."), so they are printed as they come.
function actionWords(err) {
  if (err?.status === 403) return err?.body?.code === NOT_CONFIGURED_CODE ? NOT_SWITCHED_ON : NOT_ADMIN_ACTION
  if (!err?.status) return UNREACHABLE
  return err?.message ?? UNREACHABLE
}

function TypeRow({ type, busy, result, onRetire, onRestore }) {
  const note = type.retired ? 'Retired. It is hidden from every picker.'
    : type.can_retire ? 'Nothing uses it.'
    : type.why_not
  return (
    <li style={{ ...card, listStyle: 'none' }} data-testid={`crop-type-${type.slug}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: '0.95rem', fontWeight: 600, color: P.dark, overflowWrap: 'anywhere' }}>
            {type.display_name}
          </span>
          <span style={{ display: 'block', fontSize: '0.8rem', color: P.mid, lineHeight: 1.4, marginTop: 2 }}>{note}</span>
        </span>
        {type.retired && (
          <button type="button" style={button} disabled={busy} onClick={() => onRestore(type)}
                  aria-label={`Bring back ${type.display_name}`}>
            {busy ? 'Bringing back…' : 'Bring back'}
          </button>
        )}
        {type.can_retire && (
          <button type="button" style={button} disabled={busy} onClick={() => onRetire(type)}
                  aria-label={`Retire ${type.display_name}`}>
            {busy ? 'Retiring…' : 'Retire'}
          </button>
        )}
      </div>
      {result && (
        <p role="status" style={{ margin: '8px 0 0', fontSize: '0.84rem', lineHeight: 1.4, color: result.ok ? P.green : P.terra }}>
          {result.text}
        </p>
      )}
    </li>
  )
}

function Section({ title, types, empty, ...rowProps }) {
  return (
    <section>
      <h2 style={heading}>{title} ({types.length})</h2>
      {types.length === 0
        ? <p style={{ fontSize: '0.84rem', color: P.light, margin: '0 0 8px' }}>{empty}</p>
        : (
          <ul style={{ margin: 0, padding: 0 }}>
            {types.map(t => (
              <TypeRow key={t.slug} type={t} busy={rowProps.busySlug === t.slug} result={rowProps.results[t.slug]}
                       onRetire={rowProps.onRetire} onRestore={rowProps.onRestore} />
            ))}
          </ul>
        )}
    </section>
  )
}

export default function CropTypesAdmin() {
  const { fetch } = useApiFetch()
  const [types, setTypes] = useState(null)
  // 'loading' | 'ready' | 'forbidden' | 'off' | 'error'
  const [state, setState] = useState('loading')
  const [loadError, setLoadError] = useState(null)
  const [busySlug, setBusySlug] = useState(null)
  const [results, setResults] = useState({})

  // `quiet` re-reads after a retire or bring back without dropping the list back to "Loading…".
  const load = useCallback(async (quiet = false) => {
    if (!quiet) { setState('loading'); setLoadError(null) }
    try {
      const data = await fetch('/api/varieties/crop-types/admin')
      setTypes(Array.isArray(data?.types) ? data.types : [])
      setState('ready')
    } catch (err) {
      if (err?.status === 403) { setState(err?.body?.code === NOT_CONFIGURED_CODE ? 'off' : 'forbidden'); return }
      if (quiet) return
      setLoadError(err?.status ? (err?.message ?? UNREACHABLE) : UNREACHABLE)
      setState('error')
    }
  }, [fetch])

  useEffect(() => { load() }, [load])

  const act = useCallback(async (type, request, done) => {
    if (busySlug) return
    setBusySlug(type.slug)
    setResults(r => ({ ...r, [type.slug]: undefined }))
    try {
      await request()
      setResults(r => ({ ...r, [type.slug]: { ok: true, text: done } }))
    } catch (err) {
      setResults(r => ({ ...r, [type.slug]: { ok: false, text: actionWords(err) } }))
    }
    await load(true)
    setBusySlug(null)
  }, [busySlug, load])

  const onRetire = useCallback((type) => act(type,
    () => fetch('/api/varieties/crop-types/retire', { method: 'POST', body: JSON.stringify({ slug: type.slug }) }),
    `Retired ${type.display_name}.`), [act, fetch])
  const onRestore = useCallback((type) => act(type,
    () => fetch('/api/varieties/crop-types', { method: 'POST', body: JSON.stringify({ restore_slug: type.slug }) }),
    `Brought back ${type.display_name}.`), [act, fetch])

  if (state === 'forbidden') return <NeutralPlacard />
  if (state === 'off') return <Shell><p role="status" style={{ color: P.mid }}>{NOT_SWITCHED_ON}</p></Shell>
  if (state === 'loading') return <Shell><p role="status" style={{ color: P.mid }}>Loading crop types…</p></Shell>
  if (state === 'error') {
    return (
      <Shell>
        <p role="alert" style={{ color: P.terra }}>Couldn't load crop types. {loadError}</p>
        <button type="button" style={button} onClick={() => load()}>Try again</button>
      </Shell>
    )
  }

  const rowProps = { busySlug, results, onRetire, onRestore }
  const list = types ?? []
  return (
    <Shell>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: P.dark, marginBottom: 2 }}>Crop types</h1>
      <p style={{ fontSize: '0.84rem', color: P.mid, marginTop: 0, marginBottom: 4, lineHeight: 1.4 }}>
        Retire a crop type nothing uses and it leaves every picker. Nothing is deleted, and you can bring it back here.
      </p>
      <Section title="Can be retired" empty="Every crop type is in use." {...rowProps}
               types={list.filter(t => t.can_retire)} />
      <Section title="Retired" empty="No crop type is retired." {...rowProps}
               types={list.filter(t => t.retired)} />
      <Section title="Can't be retired" empty="Nothing is holding a crop type in place." {...rowProps}
               types={list.filter(t => !t.retired && !t.can_retire)} />
    </Shell>
  )
}

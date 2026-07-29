// V4-SEARCH-001 + V4-SEARCH-002 — universal search, hybrid client/server.
// Core three entities (plantings /api/plants, locations /api/locations, varieties /api/varieties)
// stay CLIENT-SIDE: full lists fetched once, filtered in-browser — instant and weak-signal/offline
// tolerant (garden use). The server slice (V4-SEARCH-002) adds GET /api/search?q= (dashboard Lambda):
// projects, events, inventory, photos PLUS notes-column matches on the core three that the client
// filter can't see. Merge rule: client rows win for the core three; server rows dedupe by id and
// append. Server call is debounced 300ms with AbortController (stale responses dropped); a server
// failure degrades gracefully to the client-side experience — never blocks it.
// Voice reuses transcribe.js's Web-Speech wrapper (iOS start/no-speech watchdogs + graceful
// "type it" fallback); the mic only renders where isTranscriptionSupported() is true.
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useInOverlaySurface } from '../context/OverlayContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { startLiveTranscription, isTranscriptionSupported } from '../lib/transcribe.js'
import { P } from '../lib/constants.js'

const norm = s => (s || '').toString().toLowerCase()
const asArray = (d, key) => (Array.isArray(d) ? d : (d?.[key] ?? []))

function MagnifierIcon({ size = 18, color = P.greenDeep }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}
function MicIcon({ size = 18, color = P.greenDeep }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><line x1="12" y1="18" x2="12" y2="21" />
    </svg>
  )
}

const SERVER_DEBOUNCE_MS = 300
const SERVER_MIN_LEN = 2
const EMPTY_SERVER = { plantings: [], projects: [], locations: [], varieties: [], events: [], inventory: [], photos: [] }

export default function Search() {
  const { fetch } = useApiFetch()
  const inOverlay = useInOverlaySurface()
  const [params] = useSearchParams()
  const [q, setQ] = useState('')
  const [plants, setPlants] = useState([])
  const [locations, setLocations] = useState([])
  const [varieties, setVarieties] = useState([])
  const [loading, setLoading] = useState(true)
  const [voice, setVoice] = useState('idle') // idle | listening | error
  const [server, setServer] = useState(null)          // /api/search payload for the CURRENT query, or null
  const [serverState, setServerState] = useState('idle') // idle | loading | ok | error
  const inputRef = useRef(null)
  const voiceRef = useRef(null)
  const speechOk = isTranscriptionSupported()

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [pl, loc, vr] = await Promise.all([
          fetch('/api/plants').catch(() => []),
          fetch('/api/locations').catch(() => []),
          fetch('/api/varieties').catch(() => []),
        ])
        if (!alive) return
        setPlants(asArray(pl, 'plants'))
        setLocations(asArray(loc, 'locations'))
        setVarieties(asArray(vr, 'varieties'))
      } finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [fetch])

  // Full-page: autofocus the search box on mount. As an overlay: DEFER to the Sheet's focus-on-open
  // (it focuses the first non-close focusable = this input). If Search autofocused here, its child
  // effect would run before the Sheet's parent effect and the Sheet would capture THIS input as its
  // focus-restore target -> focus falls to <body> on close (§6, SC 2.4.3).
  useEffect(() => { if (!inOverlay) inputRef.current?.focus() }, [params, inOverlay])
  useEffect(() => () => { try { voiceRef.current?.cancel?.() } catch {} }, [])

  const stopVoice = useCallback(() => {
    try { voiceRef.current?.stop?.() } catch {}
    voiceRef.current = null
    setVoice('idle')
  }, [])
  const startVoice = useCallback(() => {
    if (!speechOk || voiceRef.current) return
    setVoice('listening')
    voiceRef.current = startLiveTranscription({
      languageCode: 'en-US',
      onResult: ({ transcript }) => { if (transcript) setQ(transcript) },
      onError: () => { voiceRef.current = null; setVoice('error') },
      onEnd: ({ finalTranscript }) => { if (finalTranscript) setQ(finalTranscript); voiceRef.current = null; setVoice('idle') },
    })
  }, [speechOk])

  const query = norm(q).trim()

  // V4-SEARCH-002: debounced server search. Abort-on-supersede prevents a slow
  // stale response landing over a newer one; any failure degrades to client-only.
  useEffect(() => {
    if (query.length < SERVER_MIN_LEN) { setServer(null); setServerState('idle'); return }
    const ctl = new AbortController()
    const t = setTimeout(() => {
      setServerState('loading')
      fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: ctl.signal })
        .then(data => { if (!ctl.signal.aborted) { setServer(data); setServerState('ok') } })
        .catch(() => { if (!ctl.signal.aborted) { setServer(null); setServerState('error') } })
    }, SERVER_DEBOUNCE_MS)
    return () => { clearTimeout(t); ctl.abort() }
  }, [query, fetch])

  const results = useMemo(() => {
    if (!query) return { plants: [], locations: [], varieties: [] }
    const hit = s => norm(s).includes(query)
    return {
      plants: plants.filter(p => hit(p.name) || hit(p.variety_ref?.name) || hit(p.variety_ref?.group)).slice(0, 40),
      locations: locations.filter(l => hit(l.name)).slice(0, 40),
      varieties: varieties.filter(v => hit(v.name)).slice(0, 40),
    }
  }, [query, plants, locations, varieties])

  // Merge: server hits on the core three that the client filter missed (notes/care-notes
  // columns live server-side only). Client rows win; dedupe by id.
  const srv = (server && serverState === 'ok') ? { ...EMPTY_SERVER, ...(server.results ?? {}) } : EMPTY_SERVER
  const extraPlantings = useMemo(() => {
    const seen = new Set(results.plants.map(p => p.id))
    return srv.plantings.filter(r => !seen.has(r.id))
  }, [results.plants, srv.plantings])
  const extraLocations = useMemo(() => {
    const seen = new Set(results.locations.map(l => l.id))
    return srv.locations.filter(r => !seen.has(r.id))
  }, [results.locations, srv.locations])
  const extraVarieties = useMemo(() => {
    const seen = new Set(results.varieties.map(v => v.id))
    return srv.varieties.filter(r => !seen.has(r.id))
  }, [results.varieties, srv.varieties])

  const total = results.plants.length + results.locations.length + results.varieties.length
    + extraPlantings.length + extraLocations.length + extraVarieties.length
    + srv.projects.length + srv.events.length + srv.inventory.length + srv.photos.length

  const rowStyle = { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, textDecoration: 'none', marginBottom: 8 }
  const nameStyle = { fontWeight: 700, color: P.dark, fontSize: '0.92rem' }
  const subStyle = { fontSize: '0.75rem', color: P.light }
  const sectionHead = { fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: P.mid, margin: '16px 2px 8px' }
  const chev = <span aria-hidden="true" style={{ color: P.light }}>{'›'}</span>

  const Row = ({ to, name, sub }) => {
    const inner = (<><div style={{ flex: 1 }}><div style={nameStyle}>{name}</div>{sub && <div style={subStyle}>{sub}</div>}</div>{chev}</>)
    return to ? <Link to={to} style={rowStyle}>{inner}</Link> : <div style={rowStyle}>{inner}</div>
  }

  const plantingRow = p => {
    const to = p.project_id && p.id ? `/projects/${p.project_id}/plantings/${p.id}` : null
    const sub = p.variety_ref?.name && p.variety_ref.name !== p.name ? p.variety_ref.name
      : (p.variety_ref?.group ?? p.project_name ?? p.snippet ?? null)
    return <Row key={p.id} to={to} name={p.name || 'Planting'} sub={sub} />
  }

  return (
    <div style={{ minHeight: inOverlay ? 0 : 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: 16 }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: P.white, border: `1px solid ${P.border}`, borderRadius: 22, height: 44, padding: '0 12px', position: 'sticky', top: 8, zIndex: 5, boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
          <MagnifierIcon />
          <input
            ref={inputRef}
            type="search"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search your whole garden"
            aria-label="Search your garden"
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: '0.95rem', color: P.dark, fontFamily: 'inherit' }}
          />
          {q && (
            <button type="button" onClick={() => { setQ(''); inputRef.current?.focus() }} aria-label="Clear search"
              style={{ border: 'none', background: 'transparent', color: P.light, fontSize: '1.1rem', cursor: 'pointer', lineHeight: 1, padding: 4 }}>{'×'}</button>
          )}
          {speechOk && (
            <button type="button" onClick={voice === 'listening' ? stopVoice : startVoice}
              aria-label={voice === 'listening' ? 'Stop voice search' : 'Voice search'}
              style={{ border: 'none', background: voice === 'listening' ? P.greenPale : 'transparent', borderRadius: '50%', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <MicIcon color={voice === 'listening' ? P.green : P.greenDeep} />
            </button>
          )}
        </div>

        {voice === 'listening' && <p style={{ ...subStyle, textAlign: 'center', margin: '10px 0 0' }}>Listening&hellip; speak your search.</p>}
        {voice === 'error' && <p style={{ ...subStyle, textAlign: 'center', margin: '10px 0 0' }}>Couldn&rsquo;t hear that &mdash; type your search instead.</p>}

        {loading && <p style={{ ...subStyle, textAlign: 'center', marginTop: 24 }}>Loading your garden&hellip;</p>}

        {!loading && !query && (
          <p style={{ color: P.mid, fontSize: '0.9rem', textAlign: 'center', marginTop: 28, lineHeight: 1.5 }}>
            Search everything in your garden &mdash; plantings, projects, locations,<br />
            varieties, events, inventory, and photo captions.
          </p>
        )}

        {!loading && query && total === 0 && serverState !== 'loading' && (
          <p style={{ color: P.mid, fontSize: '0.9rem', textAlign: 'center', marginTop: 28 }}>No matches for &ldquo;{q.trim()}&rdquo;.</p>
        )}

        {!loading && query && (results.plants.length > 0 || extraPlantings.length > 0) && (
          <>
            <div style={sectionHead}>Plantings</div>
            {results.plants.map(plantingRow)}
            {extraPlantings.map(plantingRow)}
          </>
        )}

        {!loading && query && (results.locations.length > 0 || extraLocations.length > 0) && (
          <>
            <div style={sectionHead}>Locations</div>
            {results.locations.map(l => <Row key={l.id} to={`/locations/${l.id}`} name={l.name} sub={null} />)}
            {extraLocations.map(l => <Row key={l.id} to={`/locations/${l.id}`} name={l.name} sub={l.type_label ?? null} />)}
          </>
        )}

        {!loading && query && (results.varieties.length > 0 || extraVarieties.length > 0) && (
          <>
            <div style={sectionHead}>Varieties</div>
            {results.varieties.map(v => (
              <div key={v.id} style={rowStyle}>
                <div style={{ flex: 1 }}><div style={nameStyle}>{v.name}</div>{(v.group || v.crop_type_slug) && <div style={subStyle}>{v.group || v.crop_type_slug}</div>}</div>
              </div>
            ))}
            {extraVarieties.map(v => (
              <div key={v.id} style={rowStyle}>
                <div style={{ flex: 1 }}><div style={nameStyle}>{v.name}</div>{(v.species || v.crop_type_slug) && <div style={subStyle}>{v.species || v.crop_type_slug}</div>}</div>
              </div>
            ))}
          </>
        )}

        {!loading && query && srv.projects.length > 0 && (
          <>
            <div style={sectionHead}>Projects</div>
            {srv.projects.map(pr => <Row key={pr.id} to={`/projects/${pr.id}`} name={pr.name} sub={pr.species || pr.snippet || pr.status || null} />)}
          </>
        )}

        {!loading && query && srv.events.length > 0 && (
          <>
            <div style={sectionHead}>Events</div>
            {srv.events.map(ev => (
              <Row key={ev.id}
                to={`/events/${ev.id}`}
                name={ev.title || ev.event_type}
                sub={[ev.project_name, ev.event_date ? String(ev.event_date).slice(0, 10) : null, ev.snippet].filter(Boolean).join(' · ') || null} />
            ))}
          </>
        )}

        {!loading && query && srv.inventory.length > 0 && (
          <>
            <div style={sectionHead}>Inventory</div>
            {srv.inventory.map(it => <Row key={it.id} to={`/inventory/${it.id}`} name={it.name} sub={[it.category, it.location_text].filter(Boolean).join(' · ') || null} />)}
          </>
        )}

        {!loading && query && srv.photos.length > 0 && (
          <>
            <div style={sectionHead}>Photos</div>
            {srv.photos.map(ph => (
              <Row key={ph.id}
                // V4-UNSCOPEDROUTES-001: planting link no longer needs a project pair.
                to={ph.plant_id ? `/plantings/${ph.plant_id}` : (ph.project_id ? `/projects/${ph.project_id}` : '/photos')}
                name={ph.caption} sub="Photo" />
            ))}
          </>
        )}

        {!loading && query && serverState === 'loading' && (
          <p style={{ ...subStyle, textAlign: 'center', marginTop: 16 }}>Searching the rest of your garden&hellip;</p>
        )}

      </div>
    </div>
  )
}

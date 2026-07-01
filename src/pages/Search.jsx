// V4-SEARCH-001 — universal search, client-side slice. Searches the three core entities the app
// already exposes — plantings (/api/plants), locations (/api/locations), varieties (/api/varieties) —
// filtered in-browser (instant, offline-tolerant, no new backend). Server-side universal search across
// ALL entities (events, projects, photos, guides) is the V4 follow-up (V4-SEARCH-002, on the roadmap).
// Voice reuses transcribe.js's Web-Speech wrapper (iOS start/no-speech watchdogs + graceful "type it"
// fallback); the mic only renders where isTranscriptionSupported() is true, so it's honest on iOS.
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
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

export default function Search() {
  const { fetch } = useApiFetch()
  const [params] = useSearchParams()
  const [q, setQ] = useState('')
  const [plants, setPlants] = useState([])
  const [locations, setLocations] = useState([])
  const [varieties, setVarieties] = useState([])
  const [loading, setLoading] = useState(true)
  const [voice, setVoice] = useState('idle') // idle | listening | error
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

  useEffect(() => { inputRef.current?.focus() }, [params])
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
  const results = useMemo(() => {
    if (!query) return { plants: [], locations: [], varieties: [] }
    const hit = s => norm(s).includes(query)
    return {
      plants: plants.filter(p => hit(p.name) || hit(p.variety_ref?.name) || hit(p.variety_ref?.group)).slice(0, 40),
      locations: locations.filter(l => hit(l.name)).slice(0, 40),
      varieties: varieties.filter(v => hit(v.name)).slice(0, 40),
    }
  }, [query, plants, locations, varieties])
  const total = results.plants.length + results.locations.length + results.varieties.length

  const rowStyle = { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, textDecoration: 'none', marginBottom: 8 }
  const nameStyle = { fontWeight: 700, color: P.dark, fontSize: '0.92rem' }
  const subStyle = { fontSize: '0.75rem', color: P.light }
  const sectionHead = { fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: P.mid, margin: '16px 2px 8px' }

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: 16 }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: P.white, border: `1px solid ${P.border}`, borderRadius: 22, height: 44, padding: '0 12px', position: 'sticky', top: 8, zIndex: 5, boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
          <MagnifierIcon />
          <input
            ref={inputRef}
            type="search"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search plantings, locations, varieties"
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
            Search across your plantings, locations, and varieties.<br />
            <span style={subStyle}>More of your garden becomes searchable soon.</span>
          </p>
        )}

        {!loading && query && total === 0 && (
          <p style={{ color: P.mid, fontSize: '0.9rem', textAlign: 'center', marginTop: 28 }}>No matches for &ldquo;{q.trim()}&rdquo;.</p>
        )}

        {!loading && query && results.plants.length > 0 && (
          <>
            <div style={sectionHead}>Plantings</div>
            {results.plants.map(p => {
              const to = p.project_id && p.id ? `/projects/${p.project_id}/plantings/${p.id}` : null
              const sub = p.variety_ref?.name && p.variety_ref.name !== p.name ? p.variety_ref.name : (p.variety_ref?.group ?? null)
              const inner = (<><div style={{ flex: 1 }}><div style={nameStyle}>{p.name || 'Planting'}</div>{sub && <div style={subStyle}>{sub}</div>}</div><span aria-hidden="true" style={{ color: P.light }}>{'›'}</span></>)
              return to
                ? <Link key={p.id} to={to} style={rowStyle}>{inner}</Link>
                : <div key={p.id} style={rowStyle}>{inner}</div>
            })}
          </>
        )}

        {!loading && query && results.locations.length > 0 && (
          <>
            <div style={sectionHead}>Locations</div>
            {results.locations.map(l => (
              <Link key={l.id} to={`/locations/${l.id}`} style={rowStyle}>
                <div style={{ flex: 1 }}><div style={nameStyle}>{l.name}</div></div>
                <span aria-hidden="true" style={{ color: P.light }}>{'›'}</span>
              </Link>
            ))}
          </>
        )}

        {!loading && query && results.varieties.length > 0 && (
          <>
            <div style={sectionHead}>Varieties</div>
            {results.varieties.map(v => (
              <div key={v.id} style={rowStyle}>
                <div style={{ flex: 1 }}><div style={nameStyle}>{v.name}</div>{(v.group || v.crop_type_slug) && <div style={subStyle}>{v.group || v.crop_type_slug}</div>}</div>
              </div>
            ))}
          </>
        )}

      </div>
    </div>
  )
}

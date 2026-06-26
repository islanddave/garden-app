import React, { useRef, useState, useEffect, useCallback } from 'react'
import roster from '../data/critters-roster.json'
import { P } from '../lib/constants.js'
import { useCritterCollection } from '../hooks/useCritterCollection.js'
import { useApiFetch } from '../lib/api.js'
import { fetchNotificationPrefs, saveGardenBloomSeen } from '../lib/notificationPrefsClient.js'
import GardenArrival from '../components/GardenArrival.jsx'
import critterFacts from '../data/critter-facts.json'
import CritterFactsPopover from '../components/CritterFactsPopover.jsx'
import CritterOfDay from '../components/CritterOfDay.jsx'
import { animatedArtUrl } from '../lib/critterArt.js'
import TallyDisplay from '../components/TallyDisplay.jsx'

// Critter Collection.
// Resting states (static, no motion):
//   • unseen (!got)            → SOFT VEIL: desaturated/lightened bg, dim blurred black silhouette,
//                                muted strip ("Not yet"). Recedes so discovered critters carry the grid.
//   • seen + bloom witnessed   → FULL presence (vivid themed bg, crisp colour art, name, "Seen" date).
// One-time bloom (newly-seen critter the user hasn't visually witnessed yet):
//   first time the card is scrolled FULLY into view (IntersectionObserver ≥0.9) OR tapped, it BLOOMS
//   from quiet → full with a float-in + wing-flutter settle, then is full-static forever. Witnessed set
//   persists in localStorage (per-device; server migration tracked as V4-BLOOM-001). prefers-reduced-motion
//   snaps straight to full (no motion), still marks witnessed. Reward-UX: ambient, in-context, no interrupt.
//
// view_scale (tools/compute_view_scale.py) normalizes art weight; theme (tools/assign_critter_themes.py)
// is the frozen per-critter candy-pastel tone read from the roster.

// ─── 12-tone curated candy pastel palette (spec §3.1) ────────────────────────────
const THEMES = {
  peach:      { bg: '#fbe6d6', strip: '#b9551f', name: '#5a2a16' },
  apricot:    { bg: '#fbe0c8', strip: '#b05420', name: '#5a2e15' },
  honey:      { bg: '#f2e6cd', strip: '#6e4a24', name: '#4a3216' },
  butter:     { bg: '#fbeec2', strip: '#9a6b1e', name: '#5e4410' },
  rose:       { bg: '#f7dde2', strip: '#9e3a52', name: '#5e2231' },
  blush:      { bg: '#fbe1e8', strip: '#b04a6a', name: '#5e2236' },
  lilac:      { bg: '#e7e1f3', strip: '#5c4a8c', name: '#34295e' },
  periwinkle: { bg: '#d9def4', strip: '#474c8c', name: '#2e3370' },
  sky:        { bg: '#dcebf5', strip: '#2f5d86', name: '#1f3f5e' },
  oat:        { bg: '#efe7d6', strip: '#7a5c34', name: '#4a3a1c' },
  stone:      { bg: '#e6e6dd', strip: '#5a5a4e', name: '#3c3c30' },
  teal:       { bg: '#d6e8e6', strip: '#2f6f6b', name: '#1f4f4a' },
}
const GROUP_DEFAULT = { wild: 'oat', legacy: 'honey', cryptid: 'lilac' }
const THEME_KEYS = Object.keys(THEMES)
function hashKey(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}
// Explicit frozen c.theme wins; hash fallback keeps a never-themeless backstop (group-default-free).
function getTheme(c) {
  if (c.theme && THEMES[c.theme]) return THEMES[c.theme]
  const seed = c.slug || c.id || c.name || ''
  return THEMES[THEME_KEYS[hashKey(seed) % THEME_KEYS.length]] || THEMES.oat
}

// ─── Soft-veil colour derivation (mix a tone toward cream to quiet it) ────────────
const CREAM = '#f4efe4'
function hx(c) { return [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)) }
function mix(a, b, t) {
  const x = hx(a), y = hx(b)
  return '#' + x.map((v, i) => Math.round(v * (1 - t) + y[i] * t).toString(16).padStart(2, '0')).join('')
}
function veilOf(theme) {
  return { bg: mix(theme.bg, CREAM, 0.5), strip: mix(theme.strip, CREAM, 0.34) }
}

// ─── Bloom "witnessed" persistence (localStorage; V4-BLOOM-001 = server migration) ─
const BLOOM_KEY = 'critter_bloom_seen_v1'
function loadBloomSeen() {
  try { return new Set(JSON.parse(window.localStorage.getItem(BLOOM_KEY) || '[]')) }
  catch { return new Set() }
}
function persistBloomSeen(set) {
  try { window.localStorage.setItem(BLOOM_KEY, JSON.stringify([...set])) } catch { /* private mode */ }
}
const REDUCE_MOTION = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches

// ─── Group config ─────────────────────────────────────────────────────────────────
const GROUP_ORDER  = ['wild', 'legacy', 'cryptid']
const GROUP_LABEL  = { wild: 'Around the garden', legacy: 'Legacy', cryptid: 'Curiosities' }
const GROUP_PREFIX = { wild: 'W', legacy: 'L', cryptid: 'C' }

const GOLD_FADE  = 'rgba(180, 130, 50, 0.40)'
const LABEL_GOLD = '#ffcf7a'

// ─── Card geometry ───────────────────────────────────────────────────────────────
const TILE_H      = 212
const STAGE_PCT   = '86%'
const STAGE_MAX   = 100   // BUG-CROP-001 / no-ellipsis: cap art so 8+STAGE_MAX+8+NAME_H+CAPTION_H ≤ TILE_H reserves the name band at every column width
const NAME_H      = 44    // name band: up to 3 lines + length-responsive font so the longest roster name fits WITHOUT ellipsis
const CAPTION_H   = 42
const CARD_RADIUS = 14
const CARD_SHADOW = '0 2px 4px rgba(40,30,10,.10), 0 6px 16px rgba(40,30,10,.16)'
const BLOOM_MS    = 6000

// ─── Helpers ─────────────────────────────────────────────────────────────────────
function formatSeenDate(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const opts = d.getFullYear() === new Date().getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' }
    return d.toLocaleDateString(undefined, opts)
  } catch { return '' }
}
function formatLongDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
  } catch { return '' }
}
function dexCode(group, idx) {
  return `${GROUP_PREFIX[group] || 'W'}${String(idx + 1).padStart(3, '0')}`
}

// ─── Single critter card ───────────────────────────────────────────────────────────
function CritterCard({ c, code, got, entry, initiallyBloomed, onBloomed, onOpenFacts }) {
  const theme = getTheme(c)
  const veil = veilOf(theme)
  const liRef = useRef(null)

  // phase: 'veil' (unseen, static) | 'pending' (got, awaiting first witness) | 'blooming' | 'full'
  const [phase, setPhase] = useState(() => (!got ? 'veil' : (initiallyBloomed ? 'full' : 'pending')))

  const trigger = useCallback(() => {
    setPhase(prev => {
      if (prev !== 'pending') return prev
      onBloomed(c.id)
      return REDUCE_MOTION ? 'full' : 'blooming'
    })
  }, [c.id, onBloomed])

  // FIX-5: tap a collected critter -> open its Facts/Alt-Facts popover (ambient, reward-UX OK).
  // A still-pending card blooms on first tap (existing reveal); once full, tap opens facts.
  // Unseen (!got) silhouettes stay non-interactive.
  const handleCardClick = useCallback(() => {
    if (!got) return
    if (phase === 'pending') { trigger(); return }
    if (phase === 'full') onOpenFacts({ ...c, firstSeenAt: entry?.firstSeenAt })
  }, [got, phase, trigger, onOpenFacts, c, entry])

  // BUG-A/BUG-B fix: useCritterCollection loads async, so the phase initializer above can
  // run while `got` is still false (empty Map during load). When the row resolves, a stuck
  // 'veil' card must leave the silhouette: promote earned critters to their real phase so the
  // dim/blur resting look clears AND the pending->bloom trigger (gated on phase==='pending')
  // can attach. No-op when `got` was already correct at mount.
  useEffect(() => {
    if (got && phase === 'veil') setPhase(initiallyBloomed ? 'full' : 'pending')
  }, [got, initiallyBloomed, phase])

  // First-full-view trigger (or immediate reveal where IntersectionObserver is unavailable).
  useEffect(() => {
    if (phase !== 'pending') return
    const el = liRef.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      onBloomed(c.id); setPhase('full'); return
    }
    const io = new IntersectionObserver(ents => {
      for (const e of ents) {
        if (e.isIntersecting && e.intersectionRatio >= 0.9) { io.disconnect(); trigger(); break }
      }
    }, { threshold: [0, 0.9, 1] })
    io.observe(el)
    return () => io.disconnect()
  }, [phase, c.id, onBloomed, trigger])

  // End the one-time animation → settle to full-static.
  useEffect(() => {
    if (phase !== 'blooming') return
    const t = setTimeout(() => setPhase('full'), BLOOM_MS)
    return () => clearTimeout(t)
  }, [phase])

  const animateArt = got && phase === 'full' && !REDUCE_MOTION  // V3-CRITANIM-001: ambient looping art only when fully revealed + motion allowed
  const artSrc = animateArt ? animatedArtUrl(c.image_url) : c.image_url
  const quiet = phase === 'veil' || phase === 'pending'   // soft-veil resting look
  const blooming = phase === 'blooming'
  const lit = phase === 'full' || blooming                // colour revealed

  const firstSeenLong = got ? formatLongDate(entry.firstSeenAt) : ''
  const firstSeenDate = got ? formatSeenDate(entry.firstSeenAt) : ''
  const ariaState = got
    ? `${c.name}, visited${firstSeenLong ? `, first seen ${firstSeenLong}` : ''}`
    : `${code}, not yet visited`

  // Art treatment: unseen = black silhouette; got-quiet = dim desaturated colour; lit = full colour.
  const artStyle = {
    width: '100%', height: '100%', objectFit: 'contain', display: 'block',
    transform: `scale(${c.view_scale || 1})`, transformOrigin: 'center center',
  }
  if (!got) { artStyle.filter = 'brightness(0) blur(1.3px)'; artStyle.opacity = 0.24 }
  else if (blooming) { artStyle.filter = 'none'; artStyle.opacity = 0 }  // hidden during arrival; GardenArrival flies the critter in
  else if (lit) { artStyle.filter = 'none'; artStyle.opacity = 1 }
  else { artStyle.filter = 'saturate(0.55) brightness(1.04) blur(0.6px)'; artStyle.opacity = 0.82 }

  return (
    <li
      ref={liRef}
      role="listitem"
      aria-label={ariaState}
      title={got ? `${c.name}${firstSeenLong ? ` — first seen ${firstSeenLong}` : ''}` : undefined}
      onClick={got ? handleCardClick : undefined}
      className={blooming ? 'cc-card cc-blooming' : 'cc-card'}
      style={{
        position: 'relative', height: TILE_H,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        padding: '8px 6px 0', paddingBottom: CAPTION_H,
        background: lit ? theme.bg : veil.bg,
        borderRadius: CARD_RADIUS, boxShadow: CARD_SHADOW, boxSizing: 'border-box',
        overflow: blooming ? 'visible' : 'hidden',
        zIndex: blooming ? 3 : 'auto',
        transition: 'background-color 700ms ease',
        cursor: got ? 'pointer' : 'default',
      }}
    >
      {blooming && <GardenArrival imageUrl={c.image_url} viewScale={c.view_scale || 1} />}
      <span aria-hidden="true" style={{
        position: 'absolute', top: 6, left: 6, zIndex: 2,
        minWidth: 36, height: 18, padding: '0 6px',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: lit ? theme.strip : veil.strip, borderRadius: 5,
        boxShadow: 'inset 0 0.5px 1px rgba(0,0,0,0.25), inset 0 0.5px 0 0.5px rgba(255,255,255,0.18)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.04em',
        color: LABEL_GOLD, fontVariantNumeric: 'tabular-nums',
        transition: 'background-color 700ms ease',
      }}>{code}</span>

      <div className={blooming ? 'cc-stage cc-settle' : 'cc-stage'} style={{
        width: `min(${STAGE_PCT}, 132px)`, maxHeight: STAGE_MAX, aspectRatio: '1 / 1', marginTop: 8,
        flexShrink: 0, overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <img
          src={artSrc}
          alt={got ? c.name : ''}
          loading="lazy"
          draggable={false}
          className={blooming ? 'cc-art-bloom' : undefined}
          style={artStyle}
        />
      </div>

      <div style={{
        flexShrink: 0, height: NAME_H, width: '100%', marginTop: 8,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 6px', boxSizing: 'border-box',
        opacity: got ? (lit ? 1 : 0) : 0,
        transition: 'opacity 600ms ease',
      }}>
        <span title={got ? c.name : undefined} style={{
          display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          // Length-responsive size: short names large; long names shrink to fit the 3-line band
          // with no ellipsis (longest roster name = 27 chars). No-ellipsis goal (Dave 2026-06-15).
          fontSize: (c.name || '').length <= 14 ? '0.86rem' : (c.name || '').length <= 20 ? '0.78rem' : '0.7rem',
          fontWeight: 700, lineHeight: 1.18, letterSpacing: '-0.005em',
          color: theme.name, textAlign: 'center',
          wordBreak: 'break-word', overflowWrap: 'anywhere',
        }}>
          {got ? c.name : ''}
        </span>
      </div>

      <div data-testid={`sighting-caption-${c.id}`} style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, height: CAPTION_H,
        background: lit ? theme.strip : veil.strip,
        boxShadow: 'inset 0 1.5px 0 rgba(0,0,0,0.20), inset 0 -0.5px 0 rgba(255,255,255,0.06)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '0 8px', boxSizing: 'border-box',
        transition: 'background-color 700ms ease',
      }}>
        {got ? (
          <>
            <span style={{
              fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.14em',
              color: LABEL_GOLD, textTransform: 'uppercase', lineHeight: 1.1, opacity: lit ? 1 : 0.6,
            }}>Seen</span>
            <span style={{
              marginTop: 2, fontSize: '0.8rem', fontWeight: 600,
              color: '#ffffff', fontVariantNumeric: 'tabular-nums',
              lineHeight: 1.1, letterSpacing: '0.01em', whiteSpace: 'nowrap', opacity: lit ? 1 : 0.6,
            }}>{firstSeenDate}</span>
          </>
        ) : (
          <span style={{
            fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.16em',
            color: LABEL_GOLD, textTransform: 'uppercase', opacity: 0.7,
          }}>Not yet</span>
        )}
      </div>
    </li>
  )
}

// ─── Component ───────────────────────────────────────────────────────────────────
export default function Collection() {
  const { collected, loading, error } = useCritterCollection()
  const { getToken } = useApiFetch()

  // V4-BLOOM-001: bloomSeen is now cross-device. localStorage stays the instant cache (the ref is
  // seeded from it synchronously for first paint); on mount we UNION the server set in, write the
  // union back (so a bloom witnessed on another device converges), and re-render so initiallyBloomed
  // recomputes. Monotonic union — bloom is "first reveal," never un-set. A brand-new device may
  // re-bloom a critter once before the merge lands; harmless and self-healing.
  const bloomSeenRef = useRef(null)
  if (bloomSeenRef.current === null) bloomSeenRef.current = loadBloomSeen()
  const [, forceBloomRerender] = useState(0)
  useEffect(() => {
    let on = true
    ;(async () => {
      const p = await fetchNotificationPrefs({ getToken })
      if (!on || !p || typeof p.garden_bloom_seen !== 'string') return
      let arr
      try { arr = JSON.parse(p.garden_bloom_seen) } catch { return }
      if (!Array.isArray(arr)) return
      const before = bloomSeenRef.current.size
      for (const id of arr) if (typeof id === 'string') bloomSeenRef.current.add(id)
      const serverSet = new Set(arr)
      const localHasExtras = [...bloomSeenRef.current].some(id => !serverSet.has(id))
      if (localHasExtras) saveGardenBloomSeen({ getToken, ids: [...bloomSeenRef.current] })
      if (bloomSeenRef.current.size > before) { persistBloomSeen(bloomSeenRef.current); forceBloomRerender(v => v + 1) }
    })()
    return () => { on = false }
  }, [getToken])
  const markBloomed = useCallback((id) => {
    if (bloomSeenRef.current.has(id)) return
    bloomSeenRef.current.add(id)
    persistBloomSeen(bloomSeenRef.current)
    saveGardenBloomSeen({ getToken, ids: [...bloomSeenRef.current] })
  }, [getToken])

  const byGroup = {}
  for (const c of roster) {
    const g = c.group || 'wild'
    if (!byGroup[g]) byGroup[g] = []
    byGroup[g].push(c)
  }
  const groups = GROUP_ORDER.filter(g => byGroup[g]?.length)
  const discovered = roster.filter(c => collected.has(c.id)).length

  const headerLine = loading
    ? 'Loading…'
    : `${discovered} spotted so far — the rest are out there waiting to be found.`

  const sectionRefs = useRef({})
  const scrollToGroup = g => {
    sectionRefs.current[g]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // FIX-5: which critter's Facts popover is open (null = none).
  const [factsCritter, setFactsCritter] = useState(null)

  return (
    <div style={{
      padding: '20px 16px 40px', maxWidth: 860, margin: '0 auto',
      backgroundColor: P.cream, minHeight: '100vh',
    }}>
      {/* Grid: explicit columns so phones are guaranteed 3-per-row. Bloom keyframes: a float-in +
          wing-flutter settle on the art stage + a colour reveal on the art, one-time per critter. */}
      <style>{`
        .cc-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;grid-auto-rows:${TILE_H}px;padding:0;margin:0;list-style:none;}
        @media(min-width:560px){.cc-grid{grid-template-columns:repeat(4,minmax(0,1fr));}}
        @media(min-width:760px){.cc-grid{grid-template-columns:repeat(5,minmax(0,1fr));}}
        .cc-settle{animation:ccSettle ${BLOOM_MS}ms cubic-bezier(.34,1.32,.5,1) both;}
        .cc-art-bloom{animation:ccArtBloom 800ms ease both;}
        @keyframes ccSettle{0%{transform:translateY(16px) scale(.94) rotate(-3deg)}45%{transform:translateY(-6px) scale(1.03) rotate(3deg)}62%{transform:translateY(2px) rotate(-6deg)}74%{transform:rotate(5deg)}86%{transform:rotate(-2deg)}100%{transform:translateY(0) scale(1) rotate(0)}}
        @keyframes ccArtBloom{0%{opacity:.82;filter:saturate(.55) brightness(1.04) blur(.6px)}100%{opacity:1;filter:none}}
        @media(prefers-reduced-motion:reduce){.cc-settle,.cc-art-bloom{animation:none!important}}
      `}</style>
      <div aria-live="polite" aria-atomic="true" style={{
        position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
        overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
      }} />

      <header style={{ marginBottom: 14 }}>
        <h1 style={{
          fontSize: '1.55rem', lineHeight: 1.15, color: P.dark,
          margin: '0 0 6px', fontWeight: 600, letterSpacing: '-0.01em',
        }}>
          Critter collection
        </h1>
        <p style={{ color: P.mid, fontSize: '0.92rem', lineHeight: 1.4, margin: 0, fontWeight: 500 }}>
          {headerLine}
        </p>
        {error && !loading && (
          <p style={{ color: P.terra, fontSize: '0.82rem', margin: '8px 0 0' }} role="status">
            {error}
          </p>
        )}
      </header>

      {!loading && <CritterOfDay collected={collected} />}
      {!loading && <TallyDisplay />}

      {/* Sticky jump-nav */}
      <nav aria-label="Jump to section" style={{
        position: 'sticky', top: 0, zIndex: 2,
        background: P.cream, padding: '10px 0 12px',
        marginBottom: 14, borderBottom: `0.5px solid ${P.border}`,
      }}>
        <div style={{
          display: 'flex', gap: 8,
          background: P.white, border: `0.5px solid ${P.border}`,
          borderRadius: 12, padding: 5,
          boxShadow: '0 1px 2px rgba(26,26,26,0.04)',
        }}>
          {groups.map(g => {
            const navTheme = THEMES[GROUP_DEFAULT[g]] || THEMES.oat
            return (
              <button
                key={g}
                type="button"
                onClick={() => scrollToGroup(g)}
                aria-label={`Jump to ${GROUP_LABEL[g]}`}
                style={{
                  flex: 1, minHeight: 40, padding: '8px 10px',
                  border: 'none', background: navTheme.bg,
                  borderRadius: 9, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  font: 'inherit',
                  boxShadow: '0 1px 1px rgba(26,26,26,0.06), inset 0 0.5px 0 rgba(255,255,255,0.4)',
                  transition: 'transform 80ms ease, box-shadow 80ms ease',
                }}
                onMouseDown={e => { e.currentTarget.style.transform = 'translateY(0.5px)' }}
                onMouseUp={e => { e.currentTarget.style.transform = 'translateY(0)' }}
                onTouchStart={e => { e.currentTarget.style.transform = 'translateY(0.5px)' }}
                onTouchEnd={e => { e.currentTarget.style.transform = 'translateY(0)' }}
              >
                <span style={{
                  fontSize: '0.85rem', color: P.dark, fontWeight: 700,
                  letterSpacing: '-0.005em', whiteSpace: 'nowrap',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {GROUP_LABEL[g]}
                </span>
              </button>
            )
          })}
        </div>
      </nav>

      {groups.map(group => {
        const entries = byGroup[group]
        return (
          <section
            key={group}
            ref={el => { sectionRefs.current[group] = el }}
            aria-labelledby={`group-${group}`}
            style={{ marginBottom: 28, scrollMarginTop: 90 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 8, marginBottom: 16 }}>
              <span aria-hidden="true" style={{
                flex: 1, height: 1,
                background: `linear-gradient(to right, transparent 0%, ${GOLD_FADE} 70%, ${GOLD_FADE} 100%)`,
              }} />
              <h2 id={`group-${group}`} style={{
                fontSize: '0.85rem', fontWeight: 700, color: P.dark, margin: 0,
                letterSpacing: '0.18em', textTransform: 'uppercase', whiteSpace: 'nowrap',
              }}>
                {GROUP_LABEL[group]}
              </h2>
              <span aria-hidden="true" style={{
                flex: 1, height: 1,
                background: `linear-gradient(to right, ${GOLD_FADE} 0%, ${GOLD_FADE} 30%, transparent 100%)`,
              }} />
            </div>

            <ul role="list" className="cc-grid">
              {entries.map((c, idx) => {
                const entry = collected.get(c.id)
                const got = !!entry
                const code = dexCode(group, idx)
                return (
                  <CritterCard
                    key={c.id}
                    c={c}
                    code={code}
                    got={got}
                    entry={entry}
                    initiallyBloomed={bloomSeenRef.current.has(c.id)}
                    onBloomed={markBloomed}
                    onOpenFacts={setFactsCritter}
                  />
                )
              })}
            </ul>
          </section>
        )
      })}
      {factsCritter && (
        <CritterFactsPopover
          critter={factsCritter}
          theme={getTheme(factsCritter)}
          content={critterFacts.facts[factsCritter.slug] || null}
          onClose={() => setFactsCritter(null)}
        />
      )}
    </div>
  )
}

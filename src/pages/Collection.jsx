import React, { useRef } from 'react'
import roster from '../data/critters-roster.json'
import { P } from '../lib/constants.js'
import { useCritterCollection } from '../hooks/useCritterCollection.js'

// Critter Collection V007c — per-critter view_scale normalization.
// V007b → V007c changes:
//   1. VIEW_SCALE: each critter reads `c.view_scale` (written by tools/compute_view_scale.py,
//      an automated SVG bounding-box script). Applied as CSS transform:scale() on the img,
//      clipped by stage overflow:hidden. Small-viewBox birds (hummingbird=1.6x, cardinal=1.33x)
//      now appear at roughly the same visual weight as large-viewBox mammals (wolverine=1.21x).
//      Scale range across 168 critters: 1.0–2.5, median ~1.54.
//   2. STAGE overflow:hidden restored — ensures scale() is clipped at the stage boundary
//      (preserving the ~7% card-edge padding), not at the card boundary.
//
// V007b mechanics unchanged: fully contained (no overflow past stage), consistent 86% stage
// padding, TILE_H=212 for 3-line names, 12-tone candy pastel theming.
// V100 binders: ambient, no animation/motion, no tap-to-claim, no streaks.

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
function getTheme(c) {
  const key = c.theme || GROUP_DEFAULT[c.group || 'wild'] || 'oat'
  return THEMES[key] || THEMES.oat
}

// ─── Group config ─────────────────────────────────────────────────────────────────
const GROUP_ORDER  = ['wild', 'legacy', 'cryptid']
const GROUP_LABEL  = { wild: 'Around the garden', legacy: 'Legacy', cryptid: 'Curiosities' }
const GROUP_PREFIX = { wild: 'W', legacy: 'L', cryptid: 'C' }

const GOLD_FADE  = 'rgba(180, 130, 50, 0.40)'
const LABEL_GOLD = '#ffcf7a'

// ─── Card geometry ───────────────────────────────────────────────────────────────
const TILE_H      = 212   // 212: fits 3-line names ("Ruby Throated Hummingbird") at 108px min
const TILE_W_MIN  = 108
const STAGE_PCT   = '86%' // ~7% gap on each side between critter and card edge
const CAPTION_H   = 42
const CARD_RADIUS = 14

const CARD_SHADOW = '0 2px 4px rgba(40,30,10,.10), 0 6px 16px rgba(40,30,10,.16)'

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

// ─── Component ───────────────────────────────────────────────────────────────────
export default function Collection() {
  const { collected, loading, error } = useCritterCollection()

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

  return (
    <div style={{
      padding: '20px 16px 40px',
      maxWidth: 860,
      margin: '0 auto',
      backgroundColor: P.cream,
      minHeight: '100vh',
    }}>
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

            <ul role="list" style={{
              display: 'grid',
              gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_W_MIN}px, 1fr))`,
              gap: 12,
              gridAutoRows: `${TILE_H}px`,
              padding: 0, margin: 0, listStyle: 'none',
            }}>
              {entries.map((c, idx) => {
                const theme = getTheme(c)
                const entry = collected.get(c.id)
                const got = !!entry
                const code = dexCode(group, idx)
                const firstSeenLong = got ? formatLongDate(entry.firstSeenAt) : ''
                const firstSeenDate = got ? formatSeenDate(entry.firstSeenAt) : ''
                const ariaState = got
                  ? `${c.name}, visited${firstSeenLong ? `, first seen ${firstSeenLong}` : ''}`
                  : `${code}, not yet visited`

                return (
                  <li
                    key={c.id}
                    role="listitem"
                    aria-label={ariaState}
                    title={got ? `${c.name}${firstSeenLong ? ` — first seen ${firstSeenLong}` : ''}` : undefined}
                    style={{
                      position: 'relative',
                      height: TILE_H,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      padding: '8px 6px 0',
                      background: theme.bg,
                      borderRadius: CARD_RADIUS,
                      boxShadow: CARD_SHADOW,
                      boxSizing: 'border-box',
                      overflow: 'hidden',
                    }}
                  >
                    {/* Dex badge */}
                    <span aria-hidden="true" style={{
                      position: 'absolute', top: 6, left: 6, zIndex: 2,
                      minWidth: 36, height: 18, padding: '0 6px',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      background: theme.strip, borderRadius: 5,
                      boxShadow: 'inset 0 0.5px 1px rgba(0,0,0,0.25), inset 0 0.5px 0 0.5px rgba(255,255,255,0.18)',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                      fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.04em',
                      color: LABEL_GOLD, fontVariantNumeric: 'tabular-nums',
                    }}>{code}</span>

                    {/* Art stage — 86% of card width, overflow:hidden clips the scaled art.
                        Stage provides the ~7% consistent edge padding. view_scale zooms in
                        on critters that have empty viewBox space (scale range 1.0–2.5). */}
                    <div style={{
                      width: STAGE_PCT,
                      aspectRatio: '1 / 1',
                      marginTop: 8,
                      flexShrink: 0,
                      overflow: 'hidden',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                      <img
                        src={c.image_url}
                        alt={got ? c.name : ''}
                        loading="lazy"
                        draggable={false}
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'contain',
                          display: 'block',
                          transform: `scale(${c.view_scale || 1})`,
                          transformOrigin: 'center center',
                          filter: got ? 'none' : 'brightness(0)',
                          opacity: got ? 1 : 0.55,
                        }}
                      />
                    </div>

                    {/* Full name — wraps freely, themed color, no truncation */}
                    <div style={{
                      marginTop: 8,
                      fontSize: '0.88rem',
                      fontWeight: 700,
                      lineHeight: 1.2,
                      letterSpacing: '-0.005em',
                      color: theme.name,
                      width: '100%',
                      textAlign: 'center',
                      padding: '0 6px',
                      boxSizing: 'border-box',
                      wordBreak: 'break-word',
                      overflowWrap: 'anywhere',
                    }}>
                      {got ? c.name : ''}
                    </div>

                    {/* Caption strip */}
                    <div data-testid={`sighting-caption-${c.id}`} style={{
                      position: 'absolute', left: 0, right: 0, bottom: 0,
                      height: CAPTION_H,
                      background: theme.strip,
                      boxShadow: 'inset 0 1.5px 0 rgba(0,0,0,0.20), inset 0 -0.5px 0 rgba(255,255,255,0.06)',
                      display: 'flex', flexDirection: 'column',
                      alignItems: 'center', justifyContent: 'center',
                      padding: '0 8px', boxSizing: 'border-box',
                    }}>
                      {got ? (
                        <>
                          <span style={{
                            fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.14em',
                            color: LABEL_GOLD, textTransform: 'uppercase', lineHeight: 1.1,
                          }}>Seen</span>
                          <span style={{
                            marginTop: 2, fontSize: '0.8rem', fontWeight: 600,
                            color: '#ffffff', fontVariantNumeric: 'tabular-nums',
                            lineHeight: 1.1, letterSpacing: '0.01em', whiteSpace: 'nowrap',
                          }}>{firstSeenDate}</span>
                        </>
                      ) : (
                        <span style={{
                          fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.16em',
                          color: LABEL_GOLD, textTransform: 'uppercase', opacity: 0.78,
                        }}>Not yet</span>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

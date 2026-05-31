import React, { useRef } from 'react'
import roster from '../data/critters-roster.json'
import { P } from '../lib/constants.js'
import { useCritterCollection } from '../hooks/useCritterCollection.js'

// Critter Collection V005 — Two micro-refinements on V004.
// Dave on V004 staging smoke (2026-05-31): "sooo close. lighten the lighter
// green shade in the critter block to about 50% of current darkness. I like
// the nav at the top and the section labels — great. small tweak to nav for
// critters: make it clear they are clickable"
//
// Two changes vs V004:
//   1. WILD SAGE CARD LIGHTENED ~50% (50% of current darkness retained):
//        sage:  #b1c9a9 -> #d8e4d4   (50% closer to white)
//      Terra (legacy) + gold (cryptid) UNCHANGED — Dave called out the green
//      specifically. P.dark on #d8e4d4 = ~11:1 contrast (AAA strong).
//   2. NAV TAP-AFFORDANCE — each section button now carries the EXACT color
//      of the room it jumps to: wild → lighter-sage, legacy → terra,
//      cryptid → gold-leaf. The nav reads as three colored chips you can
//      tap to enter each room. Clear button SHAPE = clear tap affordance,
//      no need for chevrons or extra ornament.
//
// All other V004 craft holds: lighter mats raise P.dark to AAA across all
// three groups; gold dex# stamps + gold SEEN/NOT YET labels; centered
// small-caps section titles flanked by gold-fade hairlines.
//
// V100 binders unchanged: ambient only, no motion, no streaks/badges-as-
// score, no tap-to-claim, uniform gold across all tiles.
//
// V005 rides V003 Jen-walkthrough PASS (jen-walkthrough-log.md row #6) —
// iteration on passed design direction (palette + nav affordance only,
// structure unchanged).

const GROUP_ORDER = ['wild', 'legacy', 'cryptid']
const GROUP_LABEL = { wild: 'Around the garden', legacy: 'Legacy', cryptid: 'Curiosities' }
const GROUP_PREFIX = { wild: 'W', legacy: 'L', cryptid: 'C' }

// Sage lightened ~50%. Terra + gold unchanged.
const GROUP_CARD = {
  wild:    { bg: '#d8e4d4', strip: '#3a5232', well: '#f8f5ec' }, // sage  +50% L vs V004
  legacy:  { bg: '#d8b8a0', strip: '#5a3a1f', well: '#f8f5ec' }, // terra (unchanged V004)
  cryptid: { bg: '#d8bc89', strip: '#5a4218', well: '#f8f5ec' }, // gold  (unchanged V004)
}

const GOLD = '#e9c878'
const GOLD_FADE = 'rgba(180, 130, 50, 0.40)'

const TILE_H = 178
const TILE_W_MIN = 108
const ART_BOX = 64
const WELL_BOX = 82
const CAPTION_H = 38
const NAME_H = 22
const CARD_RADIUS = 14
const WELL_RADIUS = 9

const CARD_SHADOW = '0 1px 2px rgba(45, 75, 50, 0.08), 0 3px 12px rgba(26, 26, 26, 0.10)'
const WELL_INSET = 'inset 0 1.5px 3px rgba(0, 0, 0, 0.18), inset 0 -1px 1px rgba(255, 255, 255, 0.6)'

function formatShortMonthYear(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const now = new Date()
    const opts = d.getFullYear() === now.getFullYear()
      ? { month: 'short' }
      : { month: 'short', year: '2-digit' }
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
  const prefix = GROUP_PREFIX[group] || 'W'
  return `${prefix}${String(idx + 1).padStart(3, '0')}`
}

export default function Collection() {
  const { collected, loading, error } = useCritterCollection()

  const byGroup = {}
  for (const c of roster) {
    const g = c.group || 'wild'
    if (!byGroup[g]) byGroup[g] = []
    byGroup[g].push(c)
  }
  const groups = GROUP_ORDER.filter(g => byGroup[g] && byGroup[g].length)
  const discovered = roster.filter(c => collected.has(c.id)).length

  const headerLine = loading
    ? 'Loading…'
    : `${discovered} spotted so far — the rest are out there waiting to be found.`

  const sectionRefs = useRef({})
  const scrollToGroup = (g) => {
    const el = sectionRefs.current[g]
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
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
          fontSize: '1.55rem',
          lineHeight: 1.15,
          color: P.dark,
          margin: '0 0 6px',
          fontWeight: 600,
          letterSpacing: '-0.01em',
        }}>
          Critter collection
        </h1>
        <p style={{
          color: P.mid,
          fontSize: '0.92rem',
          lineHeight: 1.4,
          margin: 0,
          fontWeight: 500,
        }}>
          {headerLine}
        </p>
        {error && !loading && (
          <p style={{ color: P.terra, fontSize: '0.82rem', margin: '8px 0 0' }} role="status">
            {error}
          </p>
        )}
      </header>

      {/* Sticky jump-nav — each button is the SAME color as the room it goes to.
          Tappability cue = button shape via colored fill, not just text. */}
      <nav aria-label="Jump to section" style={{
        position: 'sticky',
        top: 0,
        zIndex: 2,
        background: P.cream,
        padding: '10px 0 12px',
        marginBottom: 14,
        borderBottom: `0.5px solid ${P.border}`,
      }}>
        <div style={{
          display: 'flex',
          gap: 8,
          background: P.white,
          border: `0.5px solid ${P.border}`,
          borderRadius: 12,
          padding: 5,
          boxShadow: '0 1px 2px rgba(26,26,26,0.04)',
        }}>
          {groups.map(g => {
            const card = GROUP_CARD[g] || GROUP_CARD.wild
            return (
              <button
                key={g}
                type="button"
                onClick={() => scrollToGroup(g)}
                aria-label={`Jump to ${GROUP_LABEL[g]}`}
                style={{
                  flex: 1,
                  minHeight: 40,
                  padding: '8px 10px',
                  border: 'none',
                  // Group-tinted background = tap-affordance + room-preview.
                  background: card.bg,
                  borderRadius: 9,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  font: 'inherit',
                  // Subtle lift to read as a button, not a colored panel.
                  boxShadow: '0 1px 1px rgba(26,26,26,0.06), inset 0 0.5px 0 rgba(255,255,255,0.4)',
                  transition: 'transform 80ms ease, box-shadow 80ms ease',
                }}
                onMouseDown={(e) => { e.currentTarget.style.transform = 'translateY(0.5px)' }}
                onMouseUp={(e) => { e.currentTarget.style.transform = 'translateY(0)' }}
                onTouchStart={(e) => { e.currentTarget.style.transform = 'translateY(0.5px)' }}
                onTouchEnd={(e) => { e.currentTarget.style.transform = 'translateY(0)' }}
              >
                <span style={{
                  fontSize: '0.85rem',
                  color: P.dark,
                  fontWeight: 700,
                  letterSpacing: '-0.005em',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
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
        const card = GROUP_CARD[group] || GROUP_CARD.wild
        return (
          <section
            key={group}
            ref={(el) => { sectionRefs.current[group] = el }}
            aria-labelledby={`group-${group}`}
            style={{ marginBottom: 28, scrollMarginTop: 90 }}
          >
            {/* Centered chapter-divider section header (unchanged from V004). */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              marginTop: 8,
              marginBottom: 16,
            }}>
              <span aria-hidden="true" style={{
                flex: 1,
                height: 1,
                background: `linear-gradient(to right, transparent 0%, ${GOLD_FADE} 70%, ${GOLD_FADE} 100%)`,
              }} />
              <h2 id={`group-${group}`} style={{
                fontSize: '0.85rem',
                fontWeight: 700,
                color: P.dark,
                margin: 0,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                whiteSpace: 'nowrap',
              }}>
                {GROUP_LABEL[group]}
              </h2>
              <span aria-hidden="true" style={{
                flex: 1,
                height: 1,
                background: `linear-gradient(to right, ${GOLD_FADE} 0%, ${GOLD_FADE} 30%, transparent 100%)`,
              }} />
            </div>

            <ul role="list" style={{
              display: 'grid',
              gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_W_MIN}px, 1fr))`,
              gap: 12,
              gridAutoRows: `${TILE_H}px`,
              padding: 0,
              margin: 0,
              listStyle: 'none',
            }}>
              {entries.map((c, idx) => {
                const entry = collected.get(c.id)
                const got = !!entry
                const code = dexCode(group, idx)
                const firstSeenLong = got ? formatLongDate(entry.firstSeenAt) : ''
                const firstSeenShort = got ? formatShortMonthYear(entry.firstSeenAt) : ''
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
                      padding: '10px 8px 0',
                      background: card.bg,
                      borderRadius: CARD_RADIUS,
                      boxShadow: CARD_SHADOW,
                      boxSizing: 'border-box',
                      overflow: 'hidden',
                    }}
                  >
                    <span aria-hidden="true" style={{
                      position: 'absolute',
                      top: 6,
                      left: 6,
                      minWidth: 36,
                      height: 18,
                      padding: '0 6px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: card.strip,
                      borderRadius: 5,
                      boxShadow: 'inset 0 0.5px 1px rgba(0,0,0,0.25), inset 0 0.5px 0 0.5px rgba(255,255,255,0.18)',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                      fontSize: '0.6rem',
                      fontWeight: 700,
                      letterSpacing: '0.04em',
                      color: GOLD,
                      fontVariantNumeric: 'tabular-nums',
                    }}>{code}</span>

                    <div style={{
                      width: WELL_BOX,
                      height: WELL_BOX,
                      marginTop: 2,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: card.well,
                      borderRadius: WELL_RADIUS,
                      boxShadow: WELL_INSET,
                      flexShrink: 0,
                    }}>
                      <img
                        src={c.image_url}
                        alt={got ? c.name : ''}
                        width={ART_BOX}
                        height={ART_BOX}
                        loading="lazy"
                        draggable={false}
                        style={{
                          width: ART_BOX,
                          height: ART_BOX,
                          objectFit: 'contain',
                          display: 'block',
                          filter: got ? 'none' : 'brightness(0)',
                          opacity: got ? 1 : 0.55,
                        }}
                      />
                    </div>

                    <div style={{
                      marginTop: 8,
                      height: NAME_H,
                      lineHeight: `${NAME_H}px`,
                      fontSize: '0.9rem',
                      fontWeight: 700,
                      letterSpacing: '-0.005em',
                      color: P.dark,
                      width: '100%',
                      textAlign: 'center',
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      textOverflow: 'ellipsis',
                      padding: '0 4px',
                      boxSizing: 'border-box',
                      opacity: got ? 1 : 0.5,
                    }}>
                      {got ? c.name : (
                        <span aria-hidden="true" style={{ letterSpacing: '0.18em' }}>
                          {'···'}
                        </span>
                      )}
                    </div>

                    <div data-testid={`sighting-caption-${c.id}`} style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      bottom: 0,
                      height: CAPTION_H,
                      background: card.strip,
                      boxShadow: 'inset 0 1.5px 0 rgba(0,0,0,0.20), inset 0 -0.5px 0 rgba(255,255,255,0.06)',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '0 8px',
                      boxSizing: 'border-box',
                    }}>
                      {got ? (
                        <>
                          <span style={{
                            fontSize: '0.6rem',
                            fontWeight: 700,
                            letterSpacing: '0.14em',
                            color: GOLD,
                            textTransform: 'uppercase',
                            lineHeight: 1.1,
                          }}>Seen</span>
                          <span style={{
                            marginTop: 2,
                            fontSize: '0.8rem',
                            fontWeight: 600,
                            color: '#ffffff',
                            fontVariantNumeric: 'tabular-nums',
                            lineHeight: 1.1,
                            letterSpacing: '0.02em',
                          }}>{firstSeenShort}</span>
                        </>
                      ) : (
                        <span style={{
                          fontSize: '0.62rem',
                          fontWeight: 700,
                          letterSpacing: '0.16em',
                          color: GOLD,
                          textTransform: 'uppercase',
                          opacity: 0.78,
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

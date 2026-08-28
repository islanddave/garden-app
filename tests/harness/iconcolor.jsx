// V4-ICONCOLOR-001 tab-bar pass — real-browser check of the `filled` colour variants at ship size.
//
// This renders the ACTUAL <Icon> component against the ACTUAL registry, so it exercises the whole
// path the app uses: getIcon -> variant merge -> the colorOn gate -> applyRegionColor's per-region
// hex substitution. An inline-SVG mock would have proved nothing about any of that. jsdom cannot
// stand in either: Icon.test.jsx can assert a hex appears in the markup, but only a browser shows
// whether four coloured glyphs at 22px read as a bar or as confetti.
//
// Row 1 is mono (what ships today, tinted by tab state); row 2 is the filled variant. Same
// component, same registry, one prop different — so any difference is the variant and nothing else.
import React from 'react'
import { createRoot } from 'react-dom/client'
import Icon from '../../src/components/Icon.jsx'
import { P } from '../../src/lib/constants.js'

const TABS = [
  { key: 'nav.today', label: 'Today' },
  { key: 'nav.garden', label: 'Garden' },
  { key: 'nav.harvests', label: 'Harvests' },
  { key: 'nav.putup', label: 'Put-Up' },
]

// Mirrors BottomNav's own markup closely enough to judge spacing and mass; the FAB is inserted at
// index 2 exactly as the real bar does, because the gap it leaves changes how the row scans.
function Bar({ filled, activeKey = 'nav.today', testid }) {
  return (
    <div className="bar" data-testid={testid}>
      {TABS.map((t, i) => (
        <React.Fragment key={t.key}>
          {i === 2 && (
            <div className="tab">
              <span className="fab"><Icon name="nav.plus" size={22} decorative style={{ color: '#fff' }} /></span>
            </div>
          )}
          <div className={`tab${t.key === activeKey ? ' active' : ''}`}>
            {/* Mono is tinted by tab state, exactly as shipped. Filled carries its own hex per
                region and must NOT be tinted — a wrapper colour would flatten every region. */}
            <Icon name={t.key} size={22} decorative variant={filled ? 'filled' : undefined}
              style={filled ? undefined : { color: t.key === activeKey ? P.green : P.light }} />
            <span>{t.label}</span>
          </div>
        </React.Fragment>
      ))}
    </div>
  )
}

// 56px is a magnification for inspection, NOT a size the bar ships at. Note Icon.jsx swaps to the
// svg18 master below 21px and re-scales stroke by 24/size, so the 22 and the 56 are genuinely
// different renders — which is the point of showing both.
const Big = ({ filled }) => (
  <div className="big">
    {TABS.map(t => (
      <figure key={t.key}>
        <Icon name={t.key} size={56} decorative variant={filled ? 'filled' : undefined}
          style={filled ? undefined : { color: P.light }} />
        <figcaption>{t.label}</figcaption>
      </figure>
    ))}
  </div>
)

// The 18px master is what actually ships inside the bar (22 >= 21 selects svg24 — but several
// consumers sit below that), and it drops elements on purpose: harvests loses its leaf, garden its
// back leaf. Worth seeing, because a region that survives at 24 and vanishes at 18 is a colour
// declared against nothing.
const Small = ({ filled }) => (
  <div className="big">
    {TABS.map(t => (
      <figure key={t.key}>
        <Icon name={t.key} size={18} decorative variant={filled ? 'filled' : undefined}
          style={filled ? undefined : { color: P.light }} />
        <figcaption>{t.label} 18</figcaption>
      </figure>
    ))}
  </div>
)

createRoot(document.getElementById('root')).render(
  <>
    <h2>Mono — what ships today</h2>
    <p className="note">One colour per glyph, set by tab state. This is what replaced the
      basket and jar emoji on 2026-08-26.</p>
    <Bar testid="bar-mono" />
    <Big />

    <h2>Filled — the colour variant</h2>
    <p className="note">Rendered through the real registry and the real Icon component: variant
      merge, colour gate, per-region hex substitution.</p>
    <Bar filled testid="bar-filled" />
    <Big filled />
    <Small filled />
  </>
)

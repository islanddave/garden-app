// The one SVG shell every stats chart draws into: viewBox-scaled to the card width, tabular numbers,
// a label for screen readers (the numbers table under each card carries the detail).
import React from 'react'
import { W, FS, FS_SM, f1, svgText } from './geom.js'
import { v } from '../palette.js'

export function ChartFrame({ height, label, testId, children }) {
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid={testId}
      viewBox={`0 0 ${W} ${f1(height)}`}
      width="100%"
      preserveAspectRatio="xMidYMin meet"
      style={{ display: 'block', overflow: 'visible', ...svgText }}
    >
      {children}
    </svg>
  )
}

const TONE = { ink: 'ink', key: 'ink', body: 'ink-2', muted: 'ink-3' }

// A card-coloured outline painted under each glyph, so a label that a reference line, gridline or
// bar end runs through stays legible (the 426px render showed "typical" lines striking through values).
// paint-order rides as an attribute, not in `style`: jsdom's CSSStyleDeclaration drops the property it
// does not know, so a style-only halo serialises (and renders from a DOM dump) as a stroke OVER the text.
const HALO = { stroke: v('card'), strokeWidth: 5, strokeLinejoin: 'round' }

// tone: 'key' (bold ink), 'body' (ink-2), 'muted' (ink-3, small). `fill` overrides the tone colour.
// halo={false} for text drawn on a coloured mark rather than on the card.
export function Txt({ x, y, anchor = 'start', tone = 'body', size, fill, weight, halo = true, children }) {
  const fontSize = size ?? (tone === 'muted' ? FS_SM : FS)
  return (
    <text
      x={f1(x)}
      y={f1(y)}
      textAnchor={anchor}
      paintOrder={halo ? 'stroke' : undefined}
      style={{ fontSize, fill: fill ?? v(TONE[tone] ?? 'ink-2'), fontWeight: weight ?? (tone === 'key' ? 600 : 400), ...(halo ? HALO : null) }}
    >
      {children}
    </text>
  )
}

// A start-anchored value label on a card-coloured box, for labels that sit where a reference line or
// gridline crosses them (the halo alone leaves the line showing in the gaps between glyphs). Width is
// an estimate — about 0.56 em a character for the app's tabular figures — padded 2 units each side.
export function TxtBox({ x, y, size = FS_SM, children, ...rest }) {
  const w = String(children ?? '').length * size * 0.56 + 4
  return (
    <g>
      <Rect x={x - 2} y={y - size + 1} w={w} h={size + 2} fill={v('card')} />
      <Txt x={x} y={y} size={size} {...rest}>{children}</Txt>
    </g>
  )
}

export function Line({ x1, y1, x2, y2, stroke = v('grid'), width = 1, dash }) {
  return (
    <line
      x1={f1(x1)} y1={f1(y1)} x2={f1(x2)} y2={f1(y2)}
      style={{ stroke, strokeWidth: width, strokeDasharray: dash }}
    />
  )
}

export function Rect({ x, y, w, h, fill, rx, opacity, stroke }) {
  return (
    <rect
      x={f1(x)} y={f1(y)} width={f1(Math.max(0, w))} height={f1(Math.max(0, h))} rx={rx}
      style={{ fill, opacity, stroke, strokeWidth: stroke ? 1.4 : undefined }}
    />
  )
}

export function Dot({ x, y, r, fill, stroke, hollow }) {
  return (
    <circle
      cx={f1(x)} cy={f1(y)} r={r}
      style={hollow
        ? { fill: v('card'), stroke: fill, strokeWidth: 1.6 }
        : { fill, stroke, strokeWidth: stroke ? 1.6 : undefined }}
    />
  )
}

// Rect-list -> one path `d` (the round-1 ribbon draws hundreds of day columns as one path per colour).
export function rectsPath(rects) {
  let d = ''
  for (const r of rects) {
    if (!(r.w > 0) || !(r.h > 0)) continue
    d += `M${f1(r.x)} ${f1(r.y)}h${f1(r.w)}v${f1(r.h)}h${f1(-r.w)}z`
  }
  return d
}

// A value axis along y = `y`: tick marks and labels at each tick.
export function XAxis({ scale, values, y, label, format = String }) {
  return (
    <g>
      {values.map((t) => (
        <g key={t}>
          <Line x1={scale(t)} y1={y} x2={scale(t)} y2={y + 4} stroke={v('ink-3')} />
          <Txt x={scale(t)} y={y + 16} anchor="middle" tone="muted">{format(t)}</Txt>
        </g>
      ))}
      {label && <Txt x={scale(values[values.length - 1])} y={y + 30} anchor="end" tone="muted">{label}</Txt>}
    </g>
  )
}

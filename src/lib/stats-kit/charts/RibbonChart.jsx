// Season ribbon (round-1 design): one column per day — the day's temperature band (above 90°F in
// rust), rain hanging from a sky line, one tick per day each kind of care happened — with pins for
// first sowing, first set-out, the hottest and the wettest day.
import React from 'react'
import { ChartFrame, Txt, Line, rectsPath } from './ChartFrame.jsx'
import { linear } from './geom.js'
import { v, careColor } from '../palette.js'
import { CARE_KINDS, CARE_LABEL, dayNum, monthDay, monthStarts, isNum, num } from '../format.js'

const X0 = 62
const X1 = 394
const T_TOP = 44
const T_BOT = 92
const T_LO = 35
const T_HI = 100
const SKY = 100
const RAIN_H = 34
const RAIN_MAX = 3
const CARE_Y = 148
const PITCH = 14
const TICK_H = 8

export function layoutRibbon(section) {
  const days = (section?.series?.days ?? []).filter((d) => dayNum(d?.date) != null)
  const pins = section?.meta?.pins ?? {}
  if (days.length === 0) return null
  const first = dayNum(days[0].date)
  const last = dayNum(days[days.length - 1].date)
  const sow = dayNum(pins.first_sow)
  const d0 = sow != null && sow < first ? sow : first
  const d1 = last
  const n = d1 - d0 + 1
  const pd = (X1 - X0) / n
  const x = linear(d0, d1 + 1, X0, X1)
  const colW = Math.max(1, pd - 0.45)
  const y = (f) => T_BOT - ((Math.min(Math.max(f, T_LO), T_HI) - T_LO) / (T_HI - T_LO)) * (T_BOT - T_TOP)
  const y90 = y(90)

  const temp = []
  const hot = []
  const rain = []
  const care = Object.fromEntries(CARE_KINDS.map((k) => [k, []]))
  for (const d of days) {
    const dx = x(dayNum(d.date))
    if (isNum(d.tmax_f) && isNum(d.tmin_f)) {
      const top = y(d.tmax_f)
      const bot = y(d.tmin_f)
      if (d.tmax_f >= 90) {
        hot.push({ x: dx, y: top, w: colW, h: y90 - top })
        temp.push({ x: dx, y: y90, w: colW, h: bot - y90 })
      } else {
        temp.push({ x: dx, y: top, w: colW, h: bot - top })
      }
    }
    const r = num(d.precip_in)
    if (r >= 0.01) rain.push({ x: dx, y: SKY, w: colW, h: Math.max(1, (Math.min(r, RAIN_MAX) / RAIN_MAX) * RAIN_H) })
    for (const k of Array.isArray(d.care) ? d.care : []) {
      if (!care[k]) continue
      const i = CARE_KINDS.indexOf(k)
      care[k].push({ x: dx, y: CARE_Y + i * PITCH - TICK_H / 2, w: Math.max(1.2, pd - 0.35), h: TICK_H })
    }
  }

  const pinList = []
  if (pins.first_sow) pinList.push({ day: dayNum(pins.first_sow), word: 'Sown', date: pins.first_sow })
  if (pins.first_setout) pinList.push({ day: dayNum(pins.first_setout), word: 'Set out', date: pins.first_setout })
  if (pins.hottest?.date && isNum(pins.hottest.tmax_f)) pinList.push({ day: dayNum(pins.hottest.date), word: `${Math.round(pins.hottest.tmax_f)}°`, date: pins.hottest.date })
  if (pins.wettest?.date && isNum(pins.wettest.precip_in)) pinList.push({ day: dayNum(pins.wettest.date), word: `${pins.wettest.precip_in.toFixed(2)}″`, date: pins.wettest.date })

  const axisY = CARE_Y + CARE_KINDS.length * PITCH + 2
  const months = monthStarts(d0, d1).map((m) => {
    const a = Math.max(m.day, d0)
    const next = monthStarts(m.day + 32, m.day + 32)[0]?.day ?? d1 + 1
    const b = Math.min(next, d1 + 1)
    return { tick: m.day >= d0 ? x(m.day) : null, mid: (x(a) + x(b)) / 2, wide: x(b) - x(a) >= 22, label: m.label }
  })

  return {
    height: axisY + 24, x, d0, d1, colW, y90, axisY,
    pins: pinList.filter((p) => p.day != null && p.day >= d0 && p.day <= d1).map((p) => ({ ...p, x: x(p.day) + colW / 2 })),
    tempPath: rectsPath(temp), hotPath: rectsPath(hot), rainPath: rectsPath(rain),
    rainX0: x(first), rainX1: x(last) + colW,
    carePaths: CARE_KINDS.map((k, i) => ({ kind: k, y: CARE_Y + i * PITCH, d: rectsPath(care[k]) })),
    months,
  }
}

export default function RibbonChart({ section }) {
  const L = layoutRibbon(section)
  if (!L) return null
  const label = `Season ribbon from ${monthDay(section.series.days[0]?.date)}: daily high and low temperature, daily rain, and one tick for each day each kind of care happened.`
  return (
    <ChartFrame height={L.height} label={label} testId="chart-ribbon">
      {L.pins.map((p) => (
        <g key={p.word}>
          <Line x1={p.x} y1={30} x2={p.x} y2={L.axisY - 4} stroke={v('hair')} dash="2 2" />
          <Txt x={p.x - 1} y={12} tone="key">{p.word}</Txt>
          <Txt x={p.x - 1} y={26} tone="muted">{monthDay(p.date)}</Txt>
        </g>
      ))}
      <path d={L.tempPath} style={{ fill: v('temp') }} />
      <path d={L.hotPath} style={{ fill: v('rust') }} />
      <Line x1={X0} y1={L.y90} x2={X1} y2={L.y90} stroke={v('rust')} dash="3 3" />
      <Txt x={X0 - 6} y={L.y90 + 4} anchor="end" tone="muted">90°</Txt>
      <Txt x={X0 - 6} y={84} anchor="end">Temp</Txt>
      <Line x1={L.rainX0} y1={SKY} x2={L.rainX1} y2={SKY} stroke={v('water')} />
      <path d={L.rainPath} style={{ fill: v('water') }} />
      <Txt x={X0 - 6} y={SKY + 21} anchor="end">Rain</Txt>
      {L.carePaths.map((c) => (
        <g key={c.kind}>
          <path d={c.d} style={{ fill: careColor(c.kind) }} />
          <Txt x={X0 - 6} y={c.y + 4} anchor="end">{CARE_LABEL[c.kind]}</Txt>
        </g>
      ))}
      {L.months.map((m) => (
        <g key={m.label}>
          {m.tick != null && <Line x1={m.tick} y1={L.axisY} x2={m.tick} y2={L.axisY + 6} stroke={v('ink-3')} />}
          {m.wide && <Txt x={m.mid} y={L.axisY + 18} anchor="middle" tone="muted">{m.label}</Txt>}
        </g>
      ))}
    </ChartFrame>
  )
}

import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

// V5-LEGACYEXCEPTIONCARE-001 — the mount guard.
//
// WHY THIS FILE EXISTS. The drought signal is four layers deep: droughtSignal.js computes it,
// handler.js persists it into daily_plan.items, the page renders it, and the page is mounted. Every
// one of the first three has its own passing suite, and the whole feature is still invisible if the
// fourth is missing — which is exactly how it was first built. Nothing in a unit suite fails when a
// component is merely never mounted, so the absence is asserted HERE.
//
// A STATIC SOURCE guard rather than a render test on purpose: it needs no coordination with the
// render suites to stay honest. It is deliberately narrow — it pins the wiring, not the copy or the
// layout (GlanceCard.test.jsx pins the words by render).
//
// V5-TODAYREDESIGN-001 S3 put the line in the redesigned Today's glance card details (plan-v2 §4, §7 row 15;
// §13 MF2); finish plan §3.2 (2026-10-14) merged the drought line and the dry list into ONE line (GlanceCard's
// DryLine), still read through buildDroughtLine — the validator that refuses a "no rain in N days" note (Dave's
// ruling). S8c (L8) removed the old page and its DroughtLine.jsx, so this guards the one mount left — and the
// two links above it: TodayV2 mounts the glance card with the plan, and App mounts TodayV2 at /today.
const GLANCE = fs.readFileSync(path.resolve(__dirname, '../components/today/v2/GlanceCard.jsx'), 'utf8')
const PAGE = fs.readFileSync(path.resolve(__dirname, '../pages/TodayV2.jsx'), 'utf8')
const APP = fs.readFileSync(path.resolve(__dirname, '../App.jsx'), 'utf8')

describe('the glance card mounts the drought line', () => {
  it('reads it through buildDroughtLine (the category-slip validator)', () => {
    expect(GLANCE).toMatch(/import\s+\{\s*buildDroughtLine\s*\}\s+from\s+['"][^'"]*lib\/droughtLine\.js['"]/)
    expect(GLANCE).toMatch(/buildDroughtLine\(plan\)/)
  })
  it('renders the merged line and passes it the plan', () => {
    expect(GLANCE).toMatch(/<DryLine\b[^>]*\bplan=\{plan\}/)
  })
  it('renders it below the frost lines — frost is tonight and can kill, drought is a 20-day standing condition', () => {
    const frost = GLANCE.indexOf('<FrostLine key=')
    const drought = GLANCE.indexOf('<DryLine plan=')
    expect(frost).toBeGreaterThan(-1)
    expect(drought).toBeGreaterThan(frost)
  })
})

describe('and the glance card is on the page /today shows', () => {
  it('TodayV2 renders <GlanceCard> with the plan', () => {
    expect(PAGE).toMatch(/import\s+GlanceCard\s+from\s+['"]\.\.\/components\/today\/v2\/GlanceCard\.jsx['"]/)
    expect(PAGE).toMatch(/<GlanceCard\s+plan=\{plan\}/)
  })
  it('App mounts TodayV2 at /today', () => {
    expect(APP).toMatch(/\nimport TodayV2 from '\.\/pages\/TodayV2\.jsx'\n/)
  })
})

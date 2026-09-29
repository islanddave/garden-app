import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

// V5-LEGACYEXCEPTIONCARE-001 — the mount guard.
//
// WHY THIS FILE EXISTS. The drought signal is four layers deep: droughtSignal.js computes it,
// handler.js persists it into daily_plan.items, DroughtLine.jsx renders it, and Today.jsx mounts
// DroughtLine. Every one of the first three has its own passing suite, and the whole feature is
// still invisible if the fourth is missing — which is exactly how it was first built. Nothing in a
// unit suite fails when a component is merely never mounted, so the absence is asserted HERE.
//
// This is a STATIC SOURCE guard rather than a render test on purpose: Today.jsx's render suite is
// owned by a concurrent session, and a static assertion needs no coordination to stay honest.
// It is deliberately narrow — it pins the wiring, not the copy or the layout.

const TODAY = fs.readFileSync(
  path.resolve(__dirname, '../pages/Today.jsx'),
  'utf8',
)

describe('Today mounts the drought line', () => {
  it('imports DroughtLine', () => {
    expect(TODAY).toMatch(/import\s+DroughtLine\s+from\s+['"][^'"]*DroughtLine\.jsx['"]/)
  })

  it('renders <DroughtLine> and passes it the plan', () => {
    expect(TODAY).toMatch(/<DroughtLine\b[^>]*\bplan=\{plan\}/)
  })

  it('renders it below FrostAlertLine — frost is tonight and can kill, drought is a 20-day standing condition', () => {
    const frost = TODAY.indexOf('<FrostAlertLine')
    const drought = TODAY.indexOf('<DroughtLine')
    expect(frost).toBeGreaterThan(-1)
    expect(drought).toBeGreaterThan(-1)
    expect(drought).toBeGreaterThan(frost)
  })
})

// V5-TODAYREDESIGN-001 S3 — the redesigned Today mounts it too, in the glance card's details (plan-v2 §4, §7 row
// 15; §13 MF2). The same guard, pointed at the V2 mount (R3); V1 keeps its own above until it is removed (S8c).
const GLANCE = fs.readFileSync(path.resolve(__dirname, '../components/today/v2/GlanceCard.jsx'), 'utf8')

describe('the V2 glance card mounts the drought line', () => {
  it('imports DroughtLine', () => {
    expect(GLANCE).toMatch(/import\s+DroughtLine\s+from\s+['"][^'"]*DroughtLine\.jsx['"]/)
  })
  it('renders <DroughtLine> and passes it the plan', () => {
    expect(GLANCE).toMatch(/<DroughtLine\b[^>]*\bplan=\{plan\}/)
  })
  it('renders it below FrostAlertLine, in the same reading order as V1', () => {
    const frost = GLANCE.indexOf('<FrostAlertLine')
    const drought = GLANCE.indexOf('<DroughtLine')
    expect(frost).toBeGreaterThan(-1)
    expect(drought).toBeGreaterThan(frost)
  })
})

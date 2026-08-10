// Status-driven care routing (2026-06-22, pickup fervent-trusting-feynman):
//  - Bug A: a planting whose OWN status='dormant' routes to the Dormant bucket (skip routine care),
//    not only the cadence `dormant_skip` flag. "Romaine Roots" (status='dormant') was leaking into Water.
//  - Dave correction (2026-06-22): 'harvested' is NOT excluded from the plan — a harvested plant still
//    needs water (cut-and-come-again, repeat-harvest crops). The exclusion lives in handler.js's query.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import engine from './engine.js'
import cad from './cadence-data-v2.json'
import fm from './fertilization-model.json'

// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const { generatePlan } = engine
const __dirname = dirname(fileURLToPath(import.meta.url))
const HANDLER = decomment(readFileSync(resolve(__dirname, 'handler.js'), 'utf8'))

const base = {
  variety: 'Romaine', genus: null, project: 'Lettuce', project_id: 'pl', project_status: 'growing',
  substrate_start: '2026-01-01', last_water: '2026-05-01', last_fert: null, db_cadence: null,
}
const planFor = (p) => generatePlan({
  plantings: [p], cadence: cad, fertModel: fm, today: '2026-06-22',
  weather: { tonightLow: 60, highToday: 78, unit: 'F' }, ownerFallback: 'dave',
}).users.dave

describe('handler status exclusion (static source guard)', () => {
  it('still excludes ended/failed/dead/archived', () => {
    expect(HANDLER).toMatch(/not in \('ended','failed','dead','archived'\)/)
  })
  it("does NOT exclude 'harvested' — a harvested plant still needs water (Dave 2026-06-22)", () => {
    const m = HANDLER.match(/p\.status not in \(([^)]*)\)/)
    expect(m).toBeTruthy()
    expect(m[1]).not.toMatch(/harvested/)
  })
})

describe('engine routes status=dormant out of routine care (Bug A)', () => {
  it('a status=dormant planting lands in the dormant bucket, never Water', () => {
    const u = planFor({ id: 'dorm', name: 'Romaine Roots', status: 'dormant', ...base })
    expect(u.tasks.dormant.some((x) => x.id === 'dorm')).toBe(true)
    expect(u.tasks.water_due.some((x) => x.id === 'dorm')).toBe(false)
    expect(u.tasks.no_history.some((x) => x.id === 'dorm')).toBe(false)
  })
  it('a harvested planting still generates a watering task (engine does not skip it)', () => {
    const u = planFor({ id: 'harv', name: 'Cut Romaine', status: 'harvested', ...base })
    const inWater = u.tasks.water_due.some((x) => x.id === 'harv') || u.tasks.no_history.some((x) => x.id === 'harv')
    expect(inWater).toBe(true)
  })
})

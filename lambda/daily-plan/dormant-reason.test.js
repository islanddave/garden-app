// V4-DORMANTRESUME-001 — the dormant bucket merges two unrelated causes, and until this row the
// only thing telling them apart was the `note` string. A consumer offering "resume" needs to know
// which is which: status dormancy is a human-set field a human can clear, while the cadence
// dormant_skip flag is care DATA on a plant whose own note reads "watering now = rot/death".
// Each assertion names the source mutation that turns it red.
import { describe, it, expect } from 'vitest'
import engine from './engine.js'
import cad from './cadence-data-v2.json'
import fm from './fertilization-model.json'

const { generatePlan } = engine

const base = {
  genus: null, project: 'Beds', project_id: 'pl', project_status: 'growing',
  substrate_start: '2026-01-01', last_water: '2026-05-01', last_fert: null, db_cadence: null,
}
const planFor = (...p) => generatePlan({
  plantings: p, cadence: cad, fertModel: fm, today: '2026-06-22',
  weather: { tonightLow: 60, highToday: 78, unit: 'F' }, ownerFallback: 'dave',
}).users.dave

const find = (plan, id) => plan.tasks.dormant.find((x) => x.id === id)

describe('the dormant bucket discriminates its two causes', () => {
  // Mutation: drop the `reason` key from the dormant.push in engine.js and this goes red. The live
  // consequence is a client that can only tell the two apart by string-matching free prose.
  it('marks a status=dormant planting reason=status', () => {
    const row = find(planFor({ id: 'dorm', name: 'Garlic', variety: 'Romaine', status: 'dormant', ...base }), 'dorm')
    expect(row).toBeTruthy()
    expect(row.reason).toBe('status')
    expect(row.note).toBe('Dormant — skip routine care')
  })

  // Lithops is the ONLY dormant_skip variety in cadence-data-v2.json, and it carries no status of
  // its own here — proving the flag alone routes to the bucket.
  // Mutation: emit 'status' unconditionally and this goes red.
  it('marks a cadence dormant_skip planting reason=profile', () => {
    const row = find(planFor({ id: 'lith', name: 'Lithops', variety: 'Lithops', status: 'vegetative', ...base }), 'lith')
    expect(row).toBeTruthy()
    expect(row.reason).toBe('profile')
    expect(row.note).toMatch(/rot\/death/)
  })

  // Both true at once: dormant_skip must win, matching the precedence `note` already uses, so the
  // two fields can never describe the same row differently. Resuming this plant is the one outcome
  // the feature must never produce.
  // Mutation: flip the ternary to `p.status==='dormant' ? 'status' : 'profile'` and this goes red.
  it('gives dormant_skip precedence when a Lithops is also status=dormant', () => {
    const row = find(planFor({ id: 'both', name: 'Lithops', variety: 'Lithops', status: 'dormant', ...base }), 'both')
    expect(row).toBeTruthy()
    expect(row.reason).toBe('profile')
    expect(row.note).toMatch(/rot\/death/)
  })

  // The added key must not disturb the fields the bucket already published, and must not leak into
  // any other bucket. Mutation: rename `id` or `note` in the push and this goes red.
  it('keeps the row shape the plan already served', () => {
    const plan = planFor({ id: 'dorm', name: 'Garlic', variety: 'Romaine', status: 'dormant', ...base })
    expect(Object.keys(find(plan, 'dorm')).sort())
      .toEqual(['crop', 'id', 'name', 'note', 'project', 'project_id', 'reason'])
    expect(plan.tasks.water_due.some((x) => x.id === 'dorm')).toBe(false)
    expect(plan.counts.dormant).toBe(1)
  })
})

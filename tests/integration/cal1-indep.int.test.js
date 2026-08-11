// CAL-1 independence guard — V4-CAL1INDEP-001.
//
// THE DEFECT THIS FILE LOCKS SHUT. cultivar_weight_derived v2 computed confidence from COUNT(*) and
// STDDEV_SAMP alone. Neither can see whether two rows describe two OBSERVATIONS or one observation
// written twice, and identical ratios give stddev exactly 0 — so a duplicate promoted the group to
// 'high', the top of the ladder, on zero evidence about dispersion. resolve_harvest_weight promotes
// on that column, so the fake 'high' then overrode the curated variety reference for every future
// harvest of the cultivar. Repetition bought certainty.
//
// v3 splits the two questions the column conflated:
//   independent_n    distinct (sampled_at, ratio) observations, cross-unit twins excluded
//                    -> "how many separate weighings do I actually have?"
//   distinct_ratios  distinct ratios -> "how many different answers have I seen?"
// and rebuilds the ladder: independent_n < 2 -> provisional; distinct_ratios < 2 -> capped at
// 'medium'; otherwise the v2 cv ladder, untouched. Resolver v5 additionally moves the accumulation
// escape hatch from sample_n >= 5 to independent_n >= 5, so duplicates cannot walk in that way
// either.
//
// CAPABILITY-DETECTED, not hardcoded. integration-test.yml branches CI off `staging` and does NOT
// apply migrations, so the schema moves independently of this file. Detection is the only form of
// these assertions that is green on BOTH sides of the apply, in either order — see the same
// reasoning in cal1-sampleconf.int.test.js.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, setTestUserId, testRunId, insertProject } from './_harness.js'
import { settle, assertFixtureId } from './_cleanup.js'

const HAS_CAL1 = (await directSql`
  SELECT to_regclass('public.cultivar_weight_sample') IS NOT NULL AS ok`)[0].ok

const HAS_INDEP = HAS_CAL1 && (await directSql`
  SELECT (EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='cultivar_weight_derived'
                     AND column_name='independent_n')
      AND EXISTS (SELECT 1 FROM public.schema_version
                   WHERE version='4.23.0-cal1-indep-001')) AS ok`)[0].ok

// Phase 2 is separately parkable (see migrations/v4-cal1-indep-001/gates.yml), so the resolver half
// is detected on its own rather than assumed from the view half.
const HAS_RESOLVER_V5 = HAS_INDEP && (await directSql`
  SELECT EXISTS (SELECT 1 FROM public.schema_version
                  WHERE version='4.23.1-cal1-indep-001-resolver-v5') AS ok`)[0].ok

describe.skipIf(!HAS_INDEP)('CAL-1 independence guard (V4-CAL1INDEP-001)', () => {
  const RUN = testRunId()
  const USER = `indep_user_${RUN}`
  const CROP = `indep-crop-${RUN}`
  let projectId
  const P = {}

  // `samples` entries are [grams, count, dayOffset, unit?]. dayOffset is what makes an observation
  // distinct — two entries sharing a dayOffset AND a ratio are, by definition, one weighing. The
  // fixtures below use it deliberately in both directions.
  const mk = async (label, refGrams, samples) => {
    const cv = await directSql`
      INSERT INTO plant_varieties (name, created_by, crop_type_slug, unit_weights)
      VALUES (${label + '-' + RUN}, ${USER}, ${CROP},
              ${refGrams == null ? null : JSON.stringify({ count: refGrams })}::jsonb)
      RETURNING id`
    const pl = await directSql`
      INSERT INTO plants (project_id, name, created_by, variety_id)
      VALUES (${projectId}, ${label + '-' + RUN}, ${USER}, ${cv[0].id}) RETURNING id`
    for (const [grams, count, day, unit = 'count'] of samples) {
      await directSql`
        INSERT INTO cultivar_weight_sample
          (cultivar_id, unit, total_grams, unit_count, sampled_at, created_by)
        VALUES (${cv[0].id}, ${unit}, ${grams}, ${count},
                ${'2026-06-'.concat(String(day).padStart(2, '0'))}::timestamptz, ${USER})`
    }
    P[label] = { plantId: pl[0].id, cultivarId: cv[0].id }
  }

  const derived = async (label, unit = 'count') => (await directSql`
    SELECT sample_n::int AS sample_n, independent_n::int AS independent_n,
           distinct_ratios::int AS distinct_ratios, cv::float8 AS cv,
           grams_per_unit::float8 AS gpu, usable_for_comparison, confidence
      FROM cultivar_weight_derived
     WHERE cultivar_id = ${P[label].cultivarId} AND unit = ${unit}`)[0]

  const resolve = async (label, qty = 2, unit = 'count') => (await directSql`
    SELECT r.weight_grams::float8 AS grams, r.weight_basis AS basis
      FROM public.resolve_harvest_weight(${P[label].plantId}, ${unit}, ${qty}, NULL) r`)[0]

  beforeAll(async () => {
    setTestUserId(USER)
    projectId = (await insertProject({ name: 'indep-' + RUN, createdBy: USER })).id
    await directSql`
      INSERT INTO crop_types (slug, display_name, default_unit, unit_weights, variety_grams_required)
      VALUES (${CROP}, 'Indep Crop', 'count', ${'{"count":500}'}::jsonb, true)`

    // THE DEFECT. One weighing written twice: same day, same ratio, same unit. Two DISTINCT harvest
    // events with an identical payload produce exactly this — the 0f no-op guard keys on
    // source_event_id and cannot see it. Under v2: sample_n=2, cv=0, confidence 'high'.
    await mk('dupPair', 100, [[50, 5, 1], [50, 5, 1]])

    // The same defect walking through the accumulation escape hatch instead of the cv ladder.
    await mk('dupFive', 100, [[20, 4, 2], [20, 4, 2], [20, 4, 2], [20, 4, 2], [20, 4, 2]])

    // The live Pineapple Tomatillo shape: genuinely separate weighings that agree exactly. 3/2 and
    // 9/6 are both 1.5 — count-weighting makes the raw numbers differ while the RATIO does not, so
    // a guard keyed on the raw tuple would miss this and a guard keyed on the ratio catches it.
    await mk('exactAgreement', 100, [[3, 2, 1], [9, 6, 2]])

    // One weighing logged under two units. Neither group may corroborate itself: we cannot tell
    // which unit was the mistake, so both fail closed.
    await mk('crossUnit', 100, [[30, 2, 3, 'count'], [30, 2, 3, 'bunch']])

    // NON-REGRESSION control: real dispersion, must land exactly where the v2 ladder put it.
    await mk('genuineTight', 100, [[100, 10, 1], [102, 10, 2]])
    await mk('genuineWide', 100, [[100, 10, 1], [300, 10, 2]])
  })

  // BUG-INTFIXTURELEAK-001: was a bare await-chain with the ACCESS-EXCLUSIVE `ALTER TABLE` outside
  // the try, so one failure abandoned every delete after it. See cal1-harvweight.int.test.js.
  afterAll(async () => {
    assertFixtureId(USER)
    await settle('cal1-indep', [
      // cultivar_weight_sample carries a BEFORE DELETE immutability trigger — corrections go to the
      // void ledger and rows are never removed. Teardown is the ONLY sanctioned place to disable it.
      () => directSql`DELETE FROM cultivar_weight_void WHERE created_by = ${USER}`,
      async () => {
        let disabled = false
        try {
          await directSql`ALTER TABLE cultivar_weight_sample DISABLE TRIGGER trg_cws_immutable`
          disabled = true
          await directSql`DELETE FROM cultivar_weight_sample WHERE created_by = ${USER}`
        } finally {
          if (disabled) await directSql`ALTER TABLE cultivar_weight_sample ENABLE TRIGGER trg_cws_immutable`
        }
      },
      // entity rows point at plants and at plant_varieties by FK, so they must go first in both
      // directions — dropping plants ahead of its planting entities is an FK violation, not a no-op.
      () => directSql`DELETE FROM entity WHERE entity_type = 'planting' AND planting_ref_id IN (
        SELECT id FROM plants WHERE created_by = ${USER})`,
      () => directSql`DELETE FROM plants WHERE created_by = ${USER}`,
      () => directSql`DELETE FROM entity WHERE cultivar_ref_id IN (
        SELECT id FROM plant_varieties WHERE created_by = ${USER})`,
      () => directSql`DELETE FROM plant_varieties WHERE created_by = ${USER}`,
      () => directSql`DELETE FROM crop_types WHERE slug = ${CROP}`,
      () => directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`,
    ])
  })

  it('one weighing written twice is ONE observation, not a corroborated pair', async () => {
    const d = await derived('dupPair')
    expect(d.sample_n, 'both rows must still exist — nothing is deleted').toBe(2)
    expect(d.independent_n, 'same instant + same ratio = one observation').toBe(1)
    expect(d.cv, 'cv still reads 0; the point is that it is no longer believed').toBeCloseTo(0, 6)
    expect(d.confidence,
      `duplicate rows must not buy confidence; v2 called this 'high' on cv=0`).toBe('provisional')
    expect(d.usable_for_comparison).toBe(false)
  })

  it('a duplicate-backed factor no longer overrides the curated reference', async () => {
    // The user-visible consequence of the defect: 2 count resolved through the fake 'high' at
    // 10 g/count = 20 g, beating the curated 100 g/count = 200 g.
    const r = await resolve('dupPair', 2)
    expect(r.grams, 'must fall back to the curated 100 g/count reference, not the duplicate factor')
      .toBeCloseTo(200, 3)
    expect(r.basis).toBe('cultivar')
  })

  it.skipIf(!HAS_RESOLVER_V5)('five duplicate rows do not reach the n>=5 accumulation hatch', async () => {
    const d = await derived('dupFive')
    expect(d.sample_n).toBe(5)
    expect(d.independent_n, 'five rows, one weighing').toBe(1)
    expect(d.confidence).toBe('provisional')
    // v4 promoted on raw sample_n >= 5 and would have used 5 g/count here (2 -> 10 g).
    const r = await resolve('dupFive', 2)
    expect(r.grams, 'the escape hatch must count independent observations, not rows')
      .toBeCloseTo(200, 3)
    expect(r.basis).toBe('cultivar')
  })

  it('independent weighings that agree exactly are capped at medium, never high', async () => {
    const d = await derived('exactAgreement')
    expect(d.independent_n, 'different days = two real observations').toBe(2)
    expect(d.distinct_ratios, '3/2 and 9/6 are the same ratio').toBe(1)
    expect(d.cv).toBeCloseTo(0, 6)
    expect(d.confidence,
      'stddev 0 from one distinct ratio is arithmetic, not agreement').toBe('medium')
    // Demote-do-not-discard: 'medium' still corroborates, so two real weighings of the right
    // cultivar keep beating the catalogue. This is what preserves the reviewed Pineapple Tomatillo
    // factor in scripts/harvest-weight-ratchet-ack.json.
    expect(d.usable_for_comparison).toBe(true)
    const r = await resolve('exactAgreement', 2)
    expect(r.grams, 'the pooled 1.5 g/count must still win over the 100 g reference')
      .toBeCloseTo(3, 3)
    expect(r.basis).toBe('cultivar_sample')
  })

  it('a cross-unit twin cannot corroborate either of its two groups', async () => {
    for (const unit of ['count', 'bunch']) {
      const d = await derived('crossUnit', unit)
      expect(d.sample_n, `${unit}: the row is still there`).toBe(1)
      expect(d.independent_n, `${unit}: a twinned sample corroborates nothing`).toBe(0)
      expect(d.confidence).toBe('provisional')
      expect(d.gpu, `${unit}: it is still the only evidence this group has`).toBeCloseTo(15, 6)
    }
  })

  it('the cross-unit review queue lists both sides of the pair', async () => {
    const rows = await directSql`
      SELECT unit, twin_unit, grams_per_unit::float8 AS gpu
        FROM cultivar_weight_crossunit_suspect
       WHERE cultivar_id = ${P.crossUnit.cultivarId} ORDER BY unit`
    expect(rows.length, 'symmetric: one row per side').toBe(2)
    expect(rows.map((r) => `${r.unit}/${r.twin_unit}`)).toEqual(['bunch/count', 'count/bunch'])
    expect(rows[0].gpu).toBeCloseTo(15, 6)
  })

  it('the cv ladder above the guard is untouched', async () => {
    const tight = await derived('genuineTight')
    expect(tight.distinct_ratios).toBe(2)
    expect(tight.independent_n).toBe(2)
    expect(tight.confidence, `cv=${tight.cv} should still be high`).toBe('high')

    const wide = await derived('genuineWide')
    expect(wide.distinct_ratios).toBe(2)
    expect(wide.confidence, `cv=${wide.cv} should still be low`).toBe('low')
  })

  it('the invariant holds across every group in the database, not just the fixtures', async () => {
    const bad = await directSql`
      SELECT cultivar_id, unit, sample_n::int AS sample_n, independent_n::int AS independent_n,
             distinct_ratios::int AS distinct_ratios, confidence
        FROM cultivar_weight_derived
       WHERE (confidence = 'high' AND distinct_ratios < 2)
          OR (independent_n < 2 AND confidence <> 'provisional')
          OR (independent_n > sample_n)
          OR (usable_for_comparison IS DISTINCT FROM (independent_n >= 2))`
    expect(bad, `groups violating the independence invariant: ${JSON.stringify(bad)}`).toEqual([])
  })
})

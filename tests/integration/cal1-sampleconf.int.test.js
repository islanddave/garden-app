// cal1-sampleconf.int.test.js — CAL-1 confidence-aware sample ranking (V4-CAL1SAMPLECONF-001).
//
// Covers migrations/v4-cal1-sampleconf-001/0a-resolver-v3.sql. resolve_harvest_weight v2 ranked
// cultivar_weight_derived above the curated variety reference UNCONDITIONALLY, so a single
// unrepresentative weighing overrode catalog on 16 of 18 (cultivar,unit) groups — logging 5
// Beefsteak resolved to 140 g against a curated 1750 g. v3 promotes a derived row over the
// reference only when it is CORROBORATED.
//
//   corroborated := confidence IN ('high','medium')   -- the view defines 'provisional' as n < 2,
//                   OR sample_n >= 5                  -- escape hatch for genuinely variable crops
//
// RESOLUTION ORDER (v3):
//   1. user-supplied grams          -> 'measured'   estimated false
//   2. unit is g/kg/lb/oz           -> 'measured'   estimated false
//   3. derived, CORROBORATED        -> 'cultivar'   estimated true
//   4. plant_varieties.unit_weights -> 'cultivar'   estimated true
//   5. derived, provisional         -> 'cultivar'   estimated true   (only where 4 is absent)
//   6. crop_types.unit_weights      -> 'crop_type'  estimated true   ONLY if the crop permits it
//   7. nothing                      -> NULL/NULL/NULL
//
// Tiers 1/2/6/7 are already covered by cal1-harvweight.int.test.js and are not re-tested here.
// This file owns the 3-vs-4-vs-5 boundary and the PUT edit-path recompute.
//
// Every assertion carries actual AND expected grams in its failure message — a bare
// "expected 140 to be 1750" in CI does not say which cultivar, which tier, or why.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, setTestUserId, testRunId, insertProject } from './_harness.js'
import { handler as eventsHandler } from '../../lambda/events/index.js'

const HAS_V3 = (await directSql`
  SELECT (to_regclass('public.cultivar_weight_derived') IS NOT NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='cultivar_weight_derived' AND column_name='confidence')
    AND EXISTS (SELECT 1 FROM public.schema_version
                 WHERE version='4.20.6-cal1-sampleconf-001')) AS ok`)[0].ok

// V4-HARVBASIS-SAMPLE-001 phase 2 — resolver v4 splits the basis vocabulary: the two SAMPLE-backed
// tiers (3 corroborated, 5 provisional) report 'cultivar_sample'; the CURATED catalogue tier (4)
// keeps 'cultivar'. Ranking and gram values are identical to v3, so only the LABEL is version-
// dependent here.
//
// This is detected rather than hardcoded on purpose. integration-test.yml branches CI off `staging`
// and does NOT apply migrations, so the schema moves independently of this file. Hardcoding either
// label red-lines every unrelated dev push for the whole window between the staging apply and this
// commit landing — and the fix cannot be landed first either, because the new label fails against a
// v3 staging. Capability detection is the only form of this assertion that is green on BOTH sides
// of the apply, in either order.
const HAS_V4 = (await directSql`
  SELECT EXISTS (SELECT 1 FROM public.schema_version
                  WHERE version='4.20.8-harvbasis-sample-001-resolver-v4') AS ok`)[0].ok

// The basis a SAMPLE-backed resolution reports (tiers 3 and 5). Tier 4 is always 'cultivar'.
const SAMPLE_BASIS = HAS_V4 ? 'cultivar_sample' : 'cultivar'

// The vocabulary the CHECK admits at this schema version. Used by the contract guard below.
const BASIS_VOCAB = HAS_V4
  ? ['measured', 'cultivar', 'crop_type', 'cultivar_sample']
  : ['measured', 'cultivar', 'crop_type']

// Fails loudly rather than skipping if the migration is missing on a branch that HAS the rest of
// CAL-1 — a silent skip is how a resolver regression reaches prod unnoticed. Skips only where the
// whole CAL-1 surface is absent.
const HAS_CAL1 = (await directSql`
  SELECT to_regclass('public.cultivar_weight_sample') IS NOT NULL AS ok`)[0].ok
if (HAS_CAL1 && !HAS_V3) {
  throw new Error(
    'CAL-1 is present but schema_version 4.20.6-cal1-sampleconf-001 is NOT applied to this database. '
    + 'Apply migrations/v4-cal1-sampleconf-001/0a-resolver-v3.sql to STAGING before pushing to dev — '
    + 'integration-test.yml branches CI off staging and does not apply migrations itself.')
}

describe.skipIf(!HAS_CAL1)('CAL-1 confidence-aware sample ranking (V4-CAL1SAMPLECONF-001)', () => {
  const RUN = testRunId()
  const USER = `sconf_user_${RUN}`
  const CROP = `sconf-crop-${RUN}`        // variety_grams_required = TRUE (tomato-like)
  const CROP_OPEN = `sconf-open-${RUN}`   // variety_grams_required = FALSE
  let projectId
  const P = {}   // label -> { plantId, cultivarId }

  // Fixture weights are chosen so every expected value is an exact integer at the quantities used,
  // which keeps failure messages readable (no floating-point noise in the diff).
  const mk = async (label, cropSlug, refGrams, samples) => {
    const cv = await directSql`
      INSERT INTO plant_varieties (name, created_by, crop_type_slug, unit_weights)
      VALUES (${label + '-' + RUN}, ${USER}, ${cropSlug},
              ${refGrams == null ? null : JSON.stringify({ count: refGrams })}::jsonb)
      RETURNING id`
    const pl = await directSql`
      INSERT INTO plants (project_id, name, created_by, variety_id)
      VALUES (${projectId}, ${label + '-' + RUN}, ${USER}, ${cv[0].id}) RETURNING id`
    for (const [grams, count] of samples) {
      await directSql`
        INSERT INTO cultivar_weight_sample (cultivar_id, unit, total_grams, unit_count, sampled_at, created_by)
        VALUES (${cv[0].id}, 'count', ${grams}, ${count}, now(), ${USER})`
    }
    P[label] = { plantId: pl[0].id, cultivarId: cv[0].id }
  }

  beforeAll(async () => {
    setTestUserId(USER)
    projectId = (await insertProject({ name: 'sconf-' + RUN, createdBy: USER })).id
    await directSql`
      INSERT INTO crop_types (slug, display_name, default_unit, unit_weights, variety_grams_required)
      VALUES (${CROP}, 'SConf Crop', 'count', ${'{"count":500}'}::jsonb, true)`
    await directSql`
      INSERT INTO crop_types (slug, display_name, default_unit, unit_weights, variety_grams_required)
      VALUES (${CROP_OPEN}, 'SConf Open Crop', 'count', ${'{"count":500}'}::jsonb, false)`

    // The Beefsteak shape: one 28 g fruit against a curated 350 g. The defect's headline row.
    await mk('provisional', CROP, 350, [[28, 1]])
    // n=2 agreeing to within 1.5% -> 'high'. The San Marzano Roma shape.
    await mk('high', CROP, 110, [[134, 2], [66, 1]])
    // n=3, moderate spread -> 'medium'. The Celebrity shape.
    await mk('medium', CROP, 210, [[120, 1], [100, 1], [80, 1]])
    // n=2 that disagree wildly -> cv 0.63 -> 'low', and n < 5.
    await mk('lowSmallN', CROP, 100, [[20, 1], [60, 1]])
    // Same dispersion, n=5 -> still 'low' but the escape hatch fires. Mean = 200/5 = 40.
    await mk('lowBigN', CROP, 100, [[20, 1], [60, 1], [25, 1], [55, 1], [40, 1]])
    // One weighing and NO curated reference: the sample is demoted, not discarded.
    await mk('provisionalNoRef', CROP, null, [[33, 1]])
    // Same, on a crop that WOULD permit a crop-level average (500 g). The sample must still win —
    // variety_grams_required governs crop averages, not real weighings of the cultivar itself.
    await mk('provisionalNoRefOpenCrop', CROP_OPEN, null, [[33, 1]])
  })

  afterAll(async () => {
    await directSql`DELETE FROM xp_events WHERE user_id = ${USER}`
    await directSql`DELETE FROM user_achievements WHERE user_id = ${USER}`
    await directSql`DELETE FROM user_stats WHERE user_id = ${USER}`
    await directSql`DELETE FROM app_events WHERE user_clerk_sub = ${USER}`
    await directSql`DELETE FROM harvest_log WHERE created_by = ${USER}`
    await directSql`DELETE FROM entity_memory WHERE project_id = ${projectId}`
    await directSql`DELETE FROM cultivar_weight_void WHERE created_by = ${USER}`
    // cultivar_weight_sample carries a BEFORE DELETE immutability trigger by design — corrections
    // go to the void ledger and rows are never removed. Disabled only for teardown, restored in a
    // finally. This mirrors cal1-harvweight.int.test.js; production corrections still use the ledger.
    await directSql`ALTER TABLE cultivar_weight_sample DISABLE TRIGGER trg_cws_immutable`
    try {
      await directSql`DELETE FROM cultivar_weight_sample WHERE created_by = ${USER}`
    } finally {
      await directSql`ALTER TABLE cultivar_weight_sample ENABLE TRIGGER trg_cws_immutable`
    }
    await directSql`DELETE FROM event_log WHERE created_by = ${USER}`
    await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (SELECT id FROM plants WHERE created_by = ${USER})`
    await directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ${USER})`
    await directSql`DELETE FROM plants WHERE created_by = ${USER}`
    await directSql`DELETE FROM entity WHERE cultivar_ref_id IN (SELECT id FROM plant_varieties WHERE created_by = ${USER})`
    await directSql`DELETE FROM plant_varieties WHERE created_by = ${USER}`
    await directSql`DELETE FROM crop_types WHERE slug IN (${CROP}, ${CROP_OPEN})`
    await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
  })

  const postHarvest = (plantLabel, harvest) => {
    setTestUserId(USER)
    return callHandler(eventsHandler, {
      method: 'POST', path: '/api/events',
      body: {
        project_id: projectId, event_type: 'harvest', event_date: new Date().toISOString(),
        plant_id: P[plantLabel].plantId, harvest,
      },
    })
  }

  const describeRow = async (label) => {
    const d = await directSql`
      SELECT sample_n::int AS n, confidence, grams_per_unit::float8 AS gpu
        FROM cultivar_weight_derived WHERE cultivar_id = ${P[label].cultivarId} AND unit = 'count'`
    return d.length
      ? `derived[n=${d[0].n}, confidence=${d[0].confidence}, ${d[0].gpu.toFixed(2)} g/unit]`
      : 'derived[none]'
  }

  // Asserts the resolved weight and reports enough to diagnose a failure without opening the DB:
  // which fixture, its derived state, which tier was expected, and both grams figures.
  const expectResolves = async (label, qty, expectedGrams, expectedBasis, why) => {
    const { status, body } = await postHarvest(label, { quantity: qty, unit: 'count' })
    const state = await describeRow(label)
    const actual = body?.harvest?.weight_grams == null ? null : Number(body.harvest.weight_grams)
    const ctx = `[${label}] ${state} | ${qty} count | expected ${expectedGrams} g `
      + `(${expectedBasis}, ${why}) but resolver returned ${actual} g `
      + `(basis ${body?.harvest?.weight_basis})`
    expect(status, `${ctx} — POST did not return 201`).toBe(201)
    expect(actual, ctx).toBeCloseTo(expectedGrams, 3)
    expect(body.harvest.weight_basis, ctx).toBe(expectedBasis)
    expect(body.harvest.weight_estimated, `${ctx} — estimated flag`).toBe(true)
    return body
  }

  // ── the fix: an uncorroborated sample must not beat a curated reference ──────
  it('PROVISIONAL: one weighing does NOT outrank the curated reference (the Beefsteak case)', async () => {
    // 5 x 28 g = 140 g (0.3 lb) under v2; 5 x 350 g = 1750 g (3.9 lb) is the curated answer.
    await expectResolves('provisional', 5, 1750, 'cultivar',
      'n=1 is uncorroborated, so the curated 350 g/fruit reference wins')
  })

  it('PROVISIONAL: the sample is demoted, not discarded — it still resolves where no reference exists', async () => {
    await expectResolves('provisionalNoRef', 3, 99, SAMPLE_BASIS,
      'no curated reference, so the single 33 g weighing is still the best available estimate')
  })

  it('PROVISIONAL: a real weighing still beats a crop-level average the crop would have permitted', async () => {
    // variety_grams_required=false would allow the 500 g crop number; a weighing of THIS cultivar
    // is better evidence than a crop-wide average, so tier 5 sits above tier 6.
    await expectResolves('provisionalNoRefOpenCrop', 3, 99, SAMPLE_BASIS,
      'tier 5 (provisional sample) outranks tier 6 (crop average), so NOT 3 x 500 = 1500 g')
  })

  // ── the other half: corroborated samples must KEEP winning ──────────────────
  it('HIGH: n=2 agreeing tightly outranks the reference — CAL-1 working as designed', async () => {
    // pooled 200 g / 3 units = 66.667; the reference says 110. The samples must win.
    await expectResolves('high', 3, 200, SAMPLE_BASIS,
      'confidence=high (n=2, cv~1.5%) is corroborated, so the samples beat the 110 g reference')
  })

  it('MEDIUM: n=3 outranks the reference', async () => {
    // pooled 300 g / 3 units = 100; the reference says 210.
    await expectResolves('medium', 3, 300, SAMPLE_BASIS,
      'confidence=medium (n=3) is corroborated, so the samples beat the 210 g reference')
  })

  // ── the threshold boundary ──────────────────────────────────────────────────
  it('LOW + small n: samples that disagree badly do NOT outrank the reference', async () => {
    // pooled 80/2 = 40 g vs a 100 g reference. cv 0.63 with only n=2 is not yet better evidence.
    await expectResolves('lowSmallN', 4, 400, 'cultivar',
      'confidence=low and n<5, so the 100 g reference holds rather than the 40 g pooled mean')
  })

  it('LOW + n>=5: the sample_n escape hatch promotes a genuinely variable crop', async () => {
    // Same dispersion as above, five weighings: pooled 200/5 = 40 g now beats the 100 g reference.
    // Without this, a crop whose cv never drops below 0.35 could never be corrected by real data.
    await expectResolves('lowBigN', 4, 160, SAMPLE_BASIS,
      'sample_n>=5 promotes despite confidence=low, so the 40 g pooled mean wins')
  })

  it('the promotion predicate matches the resolver for every fixture (no drift between the two)', async () => {
    const rows = await directSql`
      SELECT v.name, d.sample_n::int AS n, d.confidence,
             d.grams_per_unit::float8 AS gpu,
             (v.unit_weights->>'count')::float8 AS ref,
             (d.confidence IN ('high','medium') OR d.sample_n >= 5) AS corroborated,
             r.weight_grams::float8 AS resolved
        FROM plant_varieties v
        JOIN plants pl ON pl.variety_id = v.id AND pl.deleted_at IS NULL
        JOIN cultivar_weight_derived d ON d.cultivar_id = v.id AND d.unit = 'count'
        CROSS JOIN LATERAL public.resolve_harvest_weight(pl.id, 'count', 1, NULL) r
       WHERE v.created_by = ${USER}`
    for (const r of rows) {
      const expected = r.corroborated ? r.gpu : (r.ref ?? r.gpu)
      expect(r.resolved, `[${r.name}] n=${r.n} confidence=${r.confidence} `
        + `corroborated=${r.corroborated} derived=${r.gpu} g ref=${r.ref} g — resolver returned `
        + `${r.resolved} g for 1 count, expected ${expected} g`).toBeCloseTo(expected, 6)
    }
    expect(rows.length, 'expected all 7 sampled fixtures to appear in cultivar_weight_derived').toBe(7)
  })

  // ── the edit-path trap ──────────────────────────────────────────────────────
  // The PUT recompute in lambda/events/index.js re-derives weight_grams through the SAME resolver
  // and only preserves a prior weight when weight_estimated = false (i.e. user-supplied). So under
  // v2 an unrelated edit — changing a quality star — silently rewrote a previously-correct stored
  // weight to the single-sample number. Because the resolver is the single derivation locus and PUT
  // calls it unchanged, fixing the ranking closes this path too. These two tests prove that.
  it('EDIT PATH: an unrelated edit does not rewrite a correct weight to the single-sample value', async () => {
    const created = await postHarvest('provisional', { quantity: 5, unit: 'count' })
    const eventId = created.body.id
    const before = Number(created.body.harvest.weight_grams)
    expect(before, `POST should store the curated 1750 g, got ${before} g`).toBeCloseTo(1750, 3)

    // event_type is required on PUT, and the pairing guard refuses anything but 'harvest' while a
    // harvest_log row exists. weight is ABSENT (not null) — the "edit the star, keep my weight"
    // intent that validators.js documents.
    const { status, body } = await callHandler(eventsHandler, {
      method: 'PUT', path: `/api/events/${eventId}`,
      body: { event_type: 'harvest', harvest: { quantity: 5, unit: 'count', quality_rating: 4 } },
    })
    const after = Number(body?.harvest?.weight_grams)
    expect(status, `PUT failed: ${JSON.stringify(body)}`).toBe(200)
    expect(after, `editing only the quality star must not change the stored weight — was ${before} g `
      + `before the edit, ${after} g after (the v2 defect rewrote it to 5 x 28 = 140 g)`)
      .toBeCloseTo(before, 3)

    const stored = await directSql`
      SELECT weight_grams::float8 AS g, weight_basis FROM harvest_log
       WHERE event_id = ${eventId} AND deleted_at IS NULL`
    expect(stored[0].g, `harvest_log row after edit: ${stored[0].g} g, expected ${before} g`)
      .toBeCloseTo(before, 3)
    expect(stored[0].weight_basis, 'basis must stay cultivar').toBe('cultivar')
  })

  it('EDIT PATH: a user-supplied weight is still preserved across an unrelated edit', async () => {
    // Guards the other direction: the fix must not disturb the carry-forward of a real measurement.
    const created = await postHarvest('provisional', { quantity: 5, unit: 'count', weight: 900 })
    const eventId = created.body.id
    expect(Number(created.body.harvest.weight_grams),
      `user-typed 900 g must win over every estimate, got ${created.body.harvest.weight_grams} g`)
      .toBeCloseTo(900, 3)

    const { body } = await callHandler(eventsHandler, {
      method: 'PUT', path: `/api/events/${eventId}`,
      body: { event_type: 'harvest', harvest: { quantity: 5, unit: 'count', quality_rating: 3 } },
    })
    expect(Number(body.harvest.weight_grams),
      `the user's 900 g measurement must survive a quality-star edit, got ${body.harvest.weight_grams} g`)
      .toBeCloseTo(900, 3)
    expect(body.harvest.weight_basis, 'basis must stay measured').toBe('measured')
  })

  // ── contract guards ─────────────────────────────────────────────────────────
  it('the resolver emits no basis value outside the vocabulary this schema version admits', async () => {
    // Originally "no new weight_basis value was introduced" — a hardcoded 3-value guard against
    // someone widening chk_harvest_log_weight_basis ahead of the writer. V4-HARVBASIS-SAMPLE-001
    // added 'cultivar_sample' the safe way round (widen the CHECK first, then ship the resolver), so
    // the guard is now stated against the CHECK's ACTUAL vocabulary rather than a frozen list. The
    // property being defended is unchanged and is the important one: the writer must never emit a
    // value the constraint does not accept, because that is a 23514 on every harvest save.
    const bad = await directSql`
      SELECT DISTINCT weight_basis FROM harvest_log
       WHERE created_by = ${USER} AND weight_basis IS NOT NULL
         AND weight_basis <> ALL(${BASIS_VOCAB}::text[])`
    expect(bad.map(r => r.weight_basis),
      `the resolver emitted a basis outside ${JSON.stringify(BASIS_VOCAB)}, which is what this `
      + 'database\'s chk_harvest_log_weight_basis admits — that combination 23514s every harvest '
      + 'save (see migrations/v4-harvbasis-sample-001/0a-widen-check.sql)').toEqual([])
  })

  // The constraint and the writer must agree about the vocabulary. Asserted directly, both ways,
  // so a half-applied migration (0b without 0a, or 0a rolled back under a live v4) is caught here
  // rather than by a user losing a harvest save.
  it('the CHECK vocabulary and the installed resolver version agree', async () => {
    const admitsSample = (await directSql`
      SELECT EXISTS (
        SELECT 1 FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid AND rel.relkind = 'r'
         WHERE rel.relname = 'harvest_log'
           AND con.conname = 'chk_harvest_log_weight_basis'
           AND pg_get_constraintdef(con.oid) LIKE '%cultivar_sample%') AS ok`)[0].ok
    if (HAS_V4) {
      expect(admitsSample,
        'resolver v4 is installed (schema_version 4.20.8) but chk_harvest_log_weight_basis does NOT '
        + 'admit cultivar_sample. Every harvest save through tier 3 or 5 is 23514ing right now. '
        + 'Apply migrations/v4-harvbasis-sample-001/0a-widen-check.sql, or roll back with 0r2.').toBe(true)
    }
    // The reverse (CHECK widened, resolver still v3) is the deliberate PHASE 1 parked state and is
    // safe — nothing emits the value — so it is intentionally not asserted against.
  })

  it('no sample was voided or removed by the reranking', async () => {
    const n = await directSql`
      SELECT count(*)::int AS n FROM cultivar_weight_sample WHERE created_by = ${USER}`
    // 1 + 2 + 3 + 2 + 5 + 1 + 1 fixture samples, plus any auto-captured by the dual-weight POST above.
    expect(n[0].n, `expected at least the 15 fixture samples to survive, found ${n[0].n}`)
      .toBeGreaterThanOrEqual(15)
    const voided = await directSql`
      SELECT count(*)::int AS n FROM cultivar_weight_void v
       JOIN cultivar_weight_sample s ON s.id = v.sample_id WHERE s.created_by = ${USER}`
    expect(voided[0].n, `the reranking must void nothing, found ${voided[0].n} voided samples`).toBe(0)
  })
})

// V4-HARVWEIGHTEST-001 — static guards on the sample re-attribution migration.
//
// The functions need a live Neon and cannot run in vitest, so what is falsifiable here is their
// SHAPE — and every assertion below corresponds to a way this correction would cause real harm or
// silently stop working. Same idiom as harvestWeightRatchet.test.js.
//
// Context: cultivar_weight_sample.cultivar_id is a COPY of the source planting's cultivar, taken at
// capture time, that nothing maintains. Two live plantings were re-identified after Dave weighed
// them, leaving 4 real weighings filed under cultivars they never came from — 2 cherry tomatoes
// under Beefsteak (350 g reference) and 2 blackberry weighings under Aster, the latter promoted at
// 'high' confidence and acked for propagation.
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const DIR = path.join(ROOT, 'migrations/v4-harvweightest-001')
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8')

// A construct NAMED IN A COMMENT is not that construct. These files explain themselves at length and
// quote their own SQL while doing it, so every live-code assertion runs against decommented source.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|\s)--.*$/, '$1'))
  .join('\n')

const A_RAW = read('0a-reattribution.sql')
const A = decomment(A_RAW)
const B = decomment(read('0b-backfill-reattribute.sql'))
const R = decomment(read('0r-rollback.sql'))
const GATES = read('gates.yml')
const ACK = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/harvest-weight-ratchet-ack.json'), 'utf8'))

describe('the capture guard compares the cultivar', () => {
  // THE BUG. record_harvest_weight_sample's unchanged-re-save guard tested unit + grams + count and
  // not the cultivar, so after a re-identification an edit to the harvest matched the guard,
  // returned early, and skipped the void-and-replace the function exists to perform. The one event
  // that could have corrected the attribution was the one event guaranteed not to.
  it('adds s.cultivar_id to the unchanged-re-save guard', () => {
    const guard = A.slice(A.indexOf('IF EXISTS ('), A.indexOf('PERFORM public.void_event_weight_samples(\n    p_event_id, p_user, \'superseded'))
    expect(guard).toMatch(/s\.source_event_id = p_event_id/)
    expect(guard).toMatch(/s\.cultivar_id = v_cultivar/)
  })

  // The rest of the body is carried across verbatim from 0f-autocapture. A CREATE OR REPLACE that
  // quietly drops one of these is a behaviour change wearing a one-line diff.
  it('otherwise preserves the 0f-autocapture body', () => {
    expect(A).toMatch(/p_unit IN \('g','kg','lb','oz'\)/)
    expect(A).toMatch(/source harvest no longer carries both a count and a weight/)
    expect(A).toMatch(/superseded by an edit to the source harvest/)
    expect(A).toMatch(/auto-captured: harvest logged with both a count and a weight/)
  })
})

describe('re-attribution retires, it never destroys', () => {
  // cultivar_weight_sample is append-only under trg_cws_immutable and the corpus is evidence. The
  // retire-don't-destroy precedent is plant_anchor_derivation's superseded_at/superseded_by pair.
  it('never UPDATEs or DELETEs a sample, in any file in this migration', () => {
    for (const [name, src] of [['0a', A], ['0b', B], ['0r', R]]) {
      expect(src, `${name} must not UPDATE cultivar_weight_sample`)
        .not.toMatch(/UPDATE\s+public\.cultivar_weight_sample/i)
      expect(src, `${name} must not DELETE from cultivar_weight_sample`)
        .not.toMatch(/DELETE\s+FROM\s+public\.cultivar_weight_sample/i)
    }
  })

  it('voids the misattributed row AND re-appends under the current cultivar', () => {
    const fn = A.slice(A.indexOf('FUNCTION public.reattribute_plant_weight_samples'))
    expect(fn).toMatch(/INSERT INTO public\.cultivar_weight_void/)
    expect(fn).toMatch(/INSERT INTO public\.cultivar_weight_sample/)
    // The new row names the row it supersedes, so the correction is auditable from the data alone.
    expect(fn).toMatch(/supersedes sample/)
  })

  // sampled_at is the OBSERVATION's date, not the correction's. cultivar_weight_derived counts
  // DISTINCT (sampled_at, ratio_key) to decide independence, so stamping now() here would fuse two
  // days of weighings into one and collapse the confidence tier.
  it('carries sampled_at across rather than restamping it', () => {
    const insert = A.slice(A.indexOf('INSERT INTO public.cultivar_weight_sample\n      (cultivar_id'))
    expect(insert).toMatch(/m\.sampled_at/)
    expect(insert.slice(0, insert.indexOf('RETURNING'))).not.toMatch(/now\(\)/)
  })

  // A cleared variety has no honest row to append (cultivar_weight_sample.cultivar_id is NOT NULL),
  // but the sample must still stop describing the cultivar it no longer belongs to.
  it('voids without re-appending when the planting has no variety', () => {
    const fn = A.slice(A.indexOf('FUNCTION public.reattribute_plant_weight_samples'))
    expect(fn).toMatch(/WHERE v_cultivar IS NOT NULL/)
    // The void arm carries no such condition — it must fire either way.
    const voidArm = fn.slice(fn.indexOf('INSERT INTO public.cultivar_weight_void'), fn.indexOf('refiled AS'))
    expect(voidArm).not.toMatch(/v_cultivar IS NOT NULL/)
  })

  // The mismatch predicate IS the change detector. Keying on an observed old->new transition would
  // have missed both live re-identifications: audit_events covers plant_varieties only and holds
  // ZERO rows for either. It also makes the function idempotent, so the backfill is re-runnable.
  it('detects the mismatch itself rather than being told what changed', () => {
    const fn = A.slice(A.indexOf('FUNCTION public.reattribute_plant_weight_samples'))
    expect(fn).toMatch(/s\.cultivar_id IS DISTINCT FROM v_cultivar/)
    expect(fn).toMatch(/RETURNS integer/)
  })
})

describe('stored harvest weights are out of scope, and stay out', () => {
  // scripts/harvest-weight-ratchet.sh owns the stored estimates and carries the
  // --max-total-drop-pct guard that exists so a season total never moves under Dave unattended.
  // Re-deriving here would bypass it. This is the source-level gate gates.yml points at, because no
  // post-hoc query distinguishes "0b touched harvest_log" from "Dave edited a harvest that day".
  it('no file in this migration writes harvest_log', () => {
    for (const [name, src] of [['0a', A], ['0b', B], ['0r', R]]) {
      expect(src, `${name} must not write harvest_log`).not.toMatch(/UPDATE\s+public\.harvest_log/i)
      expect(src, `${name} must not write harvest_log`).not.toMatch(/INSERT INTO public\.harvest_log/i)
    }
  })
})

describe('the backfill is separable and fail-closed', () => {
  it('refuses to run without the mechanism applied', () => {
    expect(B).toMatch(/RAISE EXCEPTION/)
    expect(B).toMatch(/4\.23\.14-harvweightest-001-reattribute/)
  })

  // It drives the shipped function rather than reimplementing the predicate. A local copy is how
  // the v1 weight backfill drifted from the live write path (see harvestWeightRatchet.test.js).
  it('calls the function rather than hand-rolling the correction', () => {
    expect(B).toMatch(/public\.reattribute_plant_weight_samples\(/)
    expect(B).not.toMatch(/INSERT INTO public\.cultivar_weight_void/)
  })
})

describe('the rollback restores the previous behaviour honestly', () => {
  it('drops the new function and puts the pre-fix guard back', () => {
    expect(R).toMatch(/DROP FUNCTION IF EXISTS public\.reattribute_plant_weight_samples/)
    const guard = R.slice(R.indexOf('IF EXISTS ('))
    expect(guard.slice(0, guard.indexOf('THEN'))).not.toMatch(/s\.cultivar_id = v_cultivar/)
  })
})

describe('the invariant is gated, not assumed', () => {
  it('gates.yml asserts no live sample contradicts its planting', () => {
    expect(GATES).toMatch(/post_no_sample_contradicts_its_planting/)
    const gate = GATES.slice(GATES.indexOf('post_no_sample_contradicts_its_planting'))
    expect(gate).toMatch(/s\.cultivar_id <> cv\.id/)
    expect(gate.slice(0, gate.indexOf('- name:') === -1 ? gate.length : gate.indexOf('- name:')))
      .toMatch(/expect: rowcount_eq\s+value: 0/)
  })

  // 0a claims to touch no rows. If it voided one, the mechanism file did something it does not say.
  it('gates.yml proves the mechanism file was inert to the data', () => {
    expect(GATES).toMatch(/mid_no_sample_was_voided_by_the_mechanism_file/)
  })
})

describe('the Aster ack is revoked, not left armed', () => {
  // The 2026-08-06 ACCEPT was honest and wrong: both samples came from the planting named
  // "Blackberry" while it was still identified as Aster. At 'high' confidence the resolver PROMOTES
  // that factor, so the ack instructed the ratchet to propagate blackberry weights onto every Aster
  // harvest. Removing the id restores the fail-closed default (unreviewed outlier => BLOCK).
  const ASTER = 'd15d22fc-a0ca-4312-b2fb-e9b3a8c602d1'

  it('Aster is no longer acked for propagation', () => {
    expect(ACK.reviewed_cultivar_ids).not.toContain(ASTER)
  })

  // The review row STAYS. Deleting it would leave the next reviewer to rediscover the same wrong
  // conclusion from the same two agreeing samples.
  it('keeps the review, marked revoked, with the traced reason', () => {
    const r = (ACK.reviews || []).find((x) => x.cultivar_id === ASTER)
    expect(r, 'the Aster review must survive the revocation').toBeTruthy()
    expect(r.decision).toMatch(/REVOKED/)
    expect(r.why).toMatch(/re-identified/i)
  })
})

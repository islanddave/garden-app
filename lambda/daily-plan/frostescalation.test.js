// OPS-PLANHOURLY-001 — escalation-only frost alerting.
//
// Context: the frost window is 14:00-17:59 ET. Under the 3-run schedule exactly ONE evaluation landed
// in it, so the dedup key (which re-sends on any change of level or tripped-crop set) could only mint
// a second key on a genuine escalation. The hourly schedule puts FOUR evaluations in that window, and
// an afternoon of ordinary forecast wobble mints new keys that are not escalations — each one an email
// to Dave. His ruling (2026-09-13): re-check hourly, tell me only if it gets WORSE.
//
// The tests that matter most here are the SILENT ones. A suite that only proved escalations send would
// pass against the pre-change code, which sent on everything — so every "does not re-send" case below
// is the actual guard, and the escalating cases exist to prove the gate has not simply been welded shut.
import { describe, it, expect } from 'vitest';
import { escalatesBeyond, cropLevels, severityRank } from './frostEval.js';

const sent = (level, crops) => ({ tier: 'imminent', level, ...(crops ? { crops } : {}) });

describe('severityRank — the ordinal the whole gate rests on', () => {
  it('orders advisory < protect < hard_freeze, with everything unknown at 0', () => {
    expect(severityRank('advisory')).toBe(1);
    expect(severityRank('protect')).toBe(2);
    expect(severityRank('hard_freeze')).toBe(3);
    for (const junk of [undefined, null, 'none', 'heat', '', 'HARD_FREEZE']) expect(severityRank(junk)).toBe(0);
  });
});

describe('cropLevels — the per-crop map persisted for the next run', () => {
  it('collapses to {slug: level} and keeps the WORST level per crop', () => {
    expect(cropLevels([
      { slug: 'tomato', level: 'protect' },
      { slug: 'basil', level: 'hard_freeze' },
      { slug: 'tomato', level: 'hard_freeze' },   // same crop, worse — must win
    ])).toEqual({ tomato: 'hard_freeze', basil: 'hard_freeze' });
  });
  it('falls back to label when slug is absent, matching cropDigest identity', () => {
    expect(cropLevels([{ label: 'Sweet Pepper', level: 'protect' }])).toEqual({ 'Sweet Pepper': 'protect' });
  });
  it('returns null for an empty or absent breakdown rather than {}', () => {
    for (const v of [null, undefined, [], [null, false]]) expect(cropLevels(v)).toBeNull();
  });
});

describe('escalatesBeyond — sends only on worse', () => {
  it('nothing sent tonight: anything is an escalation', () => {
    expect(escalatesBeyond([], { level: 'advisory', crops: { tomato: 'advisory' } })).toBe(true);
    expect(escalatesBeyond(null, { level: 'protect' })).toBe(true);
  });

  // ── the four ways it SHOULD fire ────────────────────────────────────────────────────────────────
  it('site level escalates: advisory -> protect -> hard_freeze', () => {
    expect(escalatesBeyond([sent('advisory', { tomato: 'advisory' })],
      { level: 'protect', crops: { tomato: 'protect' } })).toBe(true);
    expect(escalatesBeyond([sent('protect', { tomato: 'protect' })],
      { level: 'hard_freeze', crops: { tomato: 'hard_freeze' } })).toBe(true);
  });
  it('a NEW crop trips that was not at risk before, at the same site level', () => {
    expect(escalatesBeyond([sent('protect', { tomato: 'protect' })],
      { level: 'protect', crops: { tomato: 'protect', basil: 'protect' } })).toBe(true);
  });
  it('an already-tripped crop escalates on its own while the headline holds', () => {
    expect(escalatesBeyond([sent('protect', { tomato: 'protect', basil: 'protect' })],
      { level: 'protect', crops: { tomato: 'protect', basil: 'hard_freeze' } })).toBe(true);
  });
  it('escalation is judged against the high-water mark of ALL sends, not just the last one', () => {
    const history = [sent('hard_freeze', { tomato: 'hard_freeze' }), sent('protect', { tomato: 'protect' })];
    // Already told him hard_freeze earlier tonight; a later protect is not news.
    expect(escalatesBeyond(history, { level: 'protect', crops: { tomato: 'protect' } })).toBe(false);
  });

  // ── the cases that MUST stay silent — these are the guard ───────────────────────────────────────
  it('identical re-evaluation does not re-send', () => {
    expect(escalatesBeyond([sent('protect', { tomato: 'protect', basil: 'protect' })],
      { level: 'protect', crops: { tomato: 'protect', basil: 'protect' } })).toBe(false);
  });
  it('the tripped set SHRINKING is good news, not an alert', () => {
    expect(escalatesBeyond([sent('protect', { tomato: 'protect', basil: 'protect' })],
      { level: 'protect', crops: { tomato: 'protect' } })).toBe(false);
  });
  it('a crop DE-escalating does not re-send', () => {
    expect(escalatesBeyond([sent('hard_freeze', { tomato: 'hard_freeze' })],
      { level: 'protect', crops: { tomato: 'protect' } })).toBe(false);
  });
  it('CHURN: a crop swaps out and back across the afternoon sends nothing after the first', () => {
    // The exact shape that mints new dedup keys hourly: same severity, membership jittering.
    const history = [sent('protect', { tomato: 'protect', basil: 'protect' })];
    expect(escalatesBeyond(history, { level: 'protect', crops: { tomato: 'protect' } })).toBe(false);
    expect(escalatesBeyond(history, { level: 'protect', crops: { tomato: 'protect', basil: 'protect' } })).toBe(false);
  });

  // ── back-compat with entries written before this change ─────────────────────────────────────────
  it('a prior entry with NO crops still caps the site level when the new decision has none either', () => {
    // Both sides crop-less, so the site rank is the whole comparison — hard_freeze already sent, a
    // later protect is not worse.
    expect(escalatesBeyond([sent('hard_freeze')], { level: 'protect' })).toBe(false);
    expect(escalatesBeyond([sent('protect')], { level: 'hard_freeze' })).toBe(true);
  });
  it('a prior entry with NO crops contributes no per-crop history, so it errs toward SENDING', () => {
    // Deliberate: for the one evening spanning the deploy, a duplicate beats a swallowed frost alert.
    expect(escalatesBeyond([sent('protect')], { level: 'protect', crops: { tomato: 'protect' } })).toBe(true);
  });
  it('ignores junk entries without throwing', () => {
    expect(escalatesBeyond([null, undefined, {}, { level: 'nonsense' }], { level: 'protect' })).toBe(true);
  });
  it('a decision with no crop breakdown is judged on site level alone', () => {
    expect(escalatesBeyond([sent('protect', { tomato: 'protect' })], { level: 'protect' })).toBe(false);
    expect(escalatesBeyond([sent('protect', { tomato: 'protect' })], { level: 'hard_freeze' })).toBe(true);
  });

  // ── the scenario Dave actually described ────────────────────────────────────────────────────────
  it('A FULL HOURLY EVENING: 4 evaluations, one worsening — exactly 2 emails', () => {
    const evals = [
      { level: 'advisory',    crops: { tomato: 'advisory', basil: 'advisory' } },   // 14:00 first word
      { level: 'advisory',    crops: { tomato: 'advisory' } },                      // 15:00 set shrank
      { level: 'advisory',    crops: { tomato: 'advisory', basil: 'advisory' } },   // 16:00 came back
      { level: 'protect',     crops: { tomato: 'protect', basil: 'advisory' } },    // 17:00 low dropped
    ];
    const history = [];
    const publishedAt = [];
    evals.forEach((e, i) => {
      if (escalatesBeyond(history, e)) { publishedAt.push(i); history.push(sent(e.level, e.crops)); }
    });
    expect(publishedAt).toEqual([0, 3]);   // the first word, and the escalation. Nothing in between.
  });
});

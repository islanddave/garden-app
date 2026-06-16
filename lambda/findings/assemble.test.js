import { describe, it, expect } from 'vitest';
import { assembleIssueFindings, normalizeSeverity, mapFindingType } from './assemble.js';
import { composeFinding, validateFinding } from './engine/index.js';

const NOW = Date.parse('2026-06-12T00:00:00Z');
const DAY = 86_400_000;
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

const issueRow = (over = {}) => ({
  event_id: 'evt-1', entity_id: 'ent-1', plant_name: 'Genovese Basil', project_name: 'Back Bench',
  event_type: 'pest', severity: 'high', event_date: iso(3), resolved_at: null, ...over,
});

describe('normalizeSeverity', () => {
  it('maps numeric smallint 1/2/3 (prod event_log.severity scheme) to bands', () => {
    expect(normalizeSeverity(1)).toBe('low');
    expect(normalizeSeverity(2)).toBe('moderate');
    expect(normalizeSeverity(3)).toBe('high');
    expect(normalizeSeverity('2')).toBe('moderate'); // string-numeric also resolves
  });
  it('maps legacy strings and defaults unknown/null/out-of-range to moderate', () => {
    expect(normalizeSeverity('medium')).toBe('moderate');
    expect(normalizeSeverity('HIGH')).toBe('high');
    expect(normalizeSeverity(null)).toBe('moderate');
    expect(normalizeSeverity('weird')).toBe('moderate');
    expect(normalizeSeverity(9)).toBe('moderate');
  });
});

describe('mapFindingType', () => {
  it('maps known event kinds, falls back to open_issue', () => {
    expect(mapFindingType('aphid infestation')).toBe('pest_pressure');
    expect(mapFindingType('wilting')).toBe('water_need');
    expect(mapFindingType('leggy growth')).toBe('light_deficit');
    expect(mapFindingType('something else')).toBe('open_issue');
  });
});

describe('assembleIssueFindings', () => {
  it('drops rows without a canonical entity_id (contract needs entity_id)', () => {
    expect(assembleIssueFindings([issueRow({ entity_id: null })])).toHaveLength(0);
  });
  it('builds a supporting first-party evidence item from the issue event', () => {
    const [r] = assembleIssueFindings([issueRow()]);
    expect(r.finding_id).toBe('issue:evt-1');
    expect(r.entity_id).toBe('ent-1');
    expect(r.source_room).toBe('Knowledge');
    expect(r.finding_type).toBe('pest_pressure');
    expect(r.subject_label).toBe('Genovese Basil (Back Bench)');
    expect(r.evidence).toEqual([
      { tier: 'first_party_log', axis: 'local', observed_at: iso(3), polarity: 'supporting' },
    ]);
    expect(r.harm).toEqual({ horizon_hours: null, external: false, irreversible: false, is_cadence_miss: false });
  });
  it('adds an authoritative (dave_confirmed) contradiction for a resolved issue', () => {
    const [r] = assembleIssueFindings([issueRow({ resolved_at: iso(1) })]);
    expect(r.evidence).toContainEqual(
      { tier: 'dave_confirmed', axis: 'local', observed_at: iso(1), polarity: 'contradicting' });
  });
});

describe('assemble → engine end-to-end (the read-model contract)', () => {
  it('a fresh high-severity issue composes to assert/ambient and validates', () => {
    const [raw] = assembleIssueFindings([issueRow()]);
    const f = composeFinding(raw, NOW);
    expect(f.assertion_mode).toBe('assert');
    expect(f.channel).toBe('ambient');          // issues are never auto-operational
    expect(f.source_room).toBe('Knowledge');
    expect(validateFinding(f).valid).toBe(true);
  });
  it('a resolved issue composes to resolved/improving and validates', () => {
    const [raw] = assembleIssueFindings([issueRow({ resolved_at: iso(1) })]);
    const f = composeFinding(raw, NOW);
    expect(f.decay_state).toBe('resolved');
    expect(f.trend).toBe('improving');
    expect(validateFinding(f).valid).toBe(true);
  });
  it('an old unresolved issue ages to ask (cold-start-style stale)', () => {
    const [raw] = assembleIssueFindings([issueRow({ severity: 'low', event_date: iso(90) })]);
    const f = composeFinding(raw, NOW);
    expect(f.decay_state).toBe('dormant');
    expect(validateFinding(f).valid).toBe(true);
  });
  it('every assembled finding validates against the schema', () => {
    const rows = [issueRow(), issueRow({ event_id: 'evt-2', resolved_at: iso(2) }),
                  issueRow({ event_id: 'evt-3', event_type: 'underwatered', severity: 'medium' }),
                  issueRow({ event_id: 'evt-4', severity: 3 }), issueRow({ event_id: 'evt-5', severity: 1 })];
    for (const raw of assembleIssueFindings(rows)) {
      expect(validateFinding(composeFinding(raw, NOW)).valid).toBe(true);
    }
  });
});

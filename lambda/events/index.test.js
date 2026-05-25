// Lambda 2.2.x events validator unit tests (V1.2a-2 Session 2).
// DB-free tests against the pure `validatePostBody` exported from index.js.
// Integration / Neon-branch tests live in tests/contracts/api.ts (V1.2b backlog).
//
// Test coverage map (brief §Tests required):
//   T2 (F9 UUID parse)            — routed at handler layer; not validator
//   T4 (F18 quantity cap)         — quantity 99999 count → 400 ✓
//   T5 (F5 severity required)     — flagged=true, severity=null → 400 ✓
//   T7 (F22 backdate)             — event_date '2050-01-01' → 400 ✓
//   Severity coupling matrix      — all 4 cases ✓
//   Non-harvest with harvest      — 400 ✓
//   Harvest without harvest       — 400 ✓
//   Invalid harvest unit          — 400 ✓ (atomicity is integration concern)

import { describe, it, expect } from 'vitest';
import { validatePostBody, HARVEST_UNITS, MAX_PLAUSIBLE, normalizeEventDate } from './validators.js';

const ok = (body) => expect(validatePostBody(body)).toBeNull();
const bad = (body, msg) => {
  const r = validatePostBody(body);
  expect(r).not.toBeNull();
  expect(r.status).toBe(400);
  if (msg) expect(r.error).toMatch(msg);
};

const basicEvent = (over = {}) => ({
  event_type: 'observation',
  project_id: 'proj-1',
  ...over,
});

const basicHarvest = (over = {}) => ({
  event_type: 'harvest',
  project_id: 'proj-1',
  harvest: { quantity: 10, unit: 'count' },
  ...over,
});

describe('validatePostBody — required fields', () => {
  it('missing event_type → 400', () => {
    bad({ project_id: 'p' }, /event_type is required/);
  });
  it('missing project_id → 400', () => {
    bad({ event_type: 'watering' }, /project_id is required/);
  });
  it('basic observation passes', () => {
    ok(basicEvent());
  });
});

describe('validatePostBody — F22 event_date range', () => {
  it('T7: event_date far future → 400', () => {
    bad(basicEvent({ event_date: '2050-01-01' }), /event_date in future/);
  });
  it('event_date far past → 400', () => {
    bad(basicEvent({ event_date: '2000-01-01' }), /event_date too far in past/);
  });
  it('event_date invalid format → 400', () => {
    bad(basicEvent({ event_date: 'not-a-date' }), /event_date invalid/);
  });
  it('event_date NOW() passes', () => {
    ok(basicEvent({ event_date: new Date().toISOString() }));
  });
  it('event_date 30 minutes in future passes (clock skew tolerance)', () => {
    const skew = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    ok(basicEvent({ event_date: skew }));
  });
});

describe('validatePostBody — F5/F6 severity coupling matrix', () => {
  it('flag=false, severity=null → OK', () => {
    ok(basicEvent({ flagged_as_issue: false, severity: null }));
  });
  it('flag=false, severity=1 → 400 (severity without flag)', () => {
    bad(
      basicEvent({ flagged_as_issue: false, severity: 1 }),
      /severity requires flagged_as_issue=true/,
    );
  });
  it('T5: flag=true, severity=null → 400 (severity required when flagged)', () => {
    bad(
      basicEvent({ flagged_as_issue: true, severity: null }),
      /severity required when flagged_as_issue=true/,
    );
  });
  it('flag=true, severity=1 → OK', () => {
    ok(basicEvent({ flagged_as_issue: true, severity: 1 }));
  });
  it('F6 — severity shape error fires before coupling error', () => {
    // severity=4 invalid shape — should fail with shape error, not coupling error.
    bad(
      basicEvent({ flagged_as_issue: true, severity: 4 }),
      /severity must be 1, 2, or 3/,
    );
  });
  it('severity=0 → 400 shape', () => {
    bad(basicEvent({ severity: 0 }), /severity must be 1, 2, or 3/);
  });
});

describe('validatePostBody — harvest required fields', () => {
  it('harvest event missing harvest → 400', () => {
    bad(
      { event_type: 'harvest', project_id: 'p' },
      /harvest fields required for event_type=harvest/,
    );
  });
  it('harvest with valid count → OK', () => {
    ok(basicHarvest());
  });
  it('harvest.quantity = 0 → 400', () => {
    bad(
      basicHarvest({ harvest: { quantity: 0, unit: 'count' } }),
      /harvest.quantity must be a positive finite number/,
    );
  });
  it('harvest.quantity = -5 → 400', () => {
    bad(
      basicHarvest({ harvest: { quantity: -5, unit: 'count' } }),
      /harvest.quantity must be a positive finite number/,
    );
  });
  it('harvest.quantity = NaN → 400', () => {
    bad(
      basicHarvest({ harvest: { quantity: NaN, unit: 'count' } }),
      /harvest.quantity must be a positive finite number/,
    );
  });
  it('harvest.quantity = Infinity → 400', () => {
    bad(
      basicHarvest({ harvest: { quantity: Infinity, unit: 'count' } }),
      /harvest.quantity must be a positive finite number/,
    );
  });
  it('harvest.unit invalid → 400', () => {
    bad(
      basicHarvest({ harvest: { quantity: 5, unit: 'pounds' } }),
      /harvest.unit invalid/,
    );
  });
  it('harvest.quality_rating out of range → 400', () => {
    bad(
      basicHarvest({ harvest: { quantity: 5, unit: 'count', quality_rating: 6 } }),
      /harvest.quality_rating must be 1-5/,
    );
  });
  it('harvest.quality_rating in range OK', () => {
    ok(basicHarvest({ harvest: { quantity: 5, unit: 'count', quality_rating: 5 } }));
  });
});

describe('validatePostBody — F18 per-unit upper bounds', () => {
  it('T4: count quantity = 99999 → 400 (exceeds 10000 cap)', () => {
    bad(
      basicHarvest({ harvest: { quantity: 99999, unit: 'count' } }),
      /exceeds max for unit count/,
    );
  });
  it('count quantity = 10000 → OK (boundary)', () => {
    ok(basicHarvest({ harvest: { quantity: 10000, unit: 'count' } }));
  });
  it('count quantity = 10001 → 400', () => {
    bad(
      basicHarvest({ harvest: { quantity: 10001, unit: 'count' } }),
      /exceeds max/,
    );
  });
  it('lb quantity = 600 → 400 (exceeds 500 cap)', () => {
    bad(
      basicHarvest({ harvest: { quantity: 600, unit: 'lb' } }),
      /exceeds max for unit lb/,
    );
  });
  it('every HARVEST_UNITS value has a MAX_PLAUSIBLE entry', () => {
    for (const u of HARVEST_UNITS) {
      expect(MAX_PLAUSIBLE[u]).toBeGreaterThan(0);
    }
  });
});

describe('validatePostBody — harvest-fields forbidden on non-harvest', () => {
  it('observation with harvest payload → 400', () => {
    bad(
      basicEvent({ harvest: { quantity: 5, unit: 'count' } }),
      /harvest fields only valid on event_type=harvest/,
    );
  });
  it('watering with harvest payload → 400', () => {
    bad(
      { event_type: 'watering', project_id: 'p', harvest: { quantity: 1, unit: 'count' } },
      /harvest fields only valid on event_type=harvest/,
    );
  });
});

describe('validatePostBody — combined flag + harvest', () => {
  it('harvest event with flag+severity → OK', () => {
    ok({
      event_type: 'harvest',
      project_id: 'p',
      flagged_as_issue: true,
      severity: 2,
      harvest: { quantity: 10, unit: 'count' },
    });
  });
  it('harvest event with flag but no severity → 400', () => {
    bad(
      {
        event_type: 'harvest',
        project_id: 'p',
        flagged_as_issue: true,
        harvest: { quantity: 10, unit: 'count' },
      },
      /severity required/,
    );
  });
});


describe('normalizeEventDate — event-date off-by-one fix (2.1.x)', () => {
  it('noon-anchors a date-only string (prevents midnight-UTC day-early display)', () => {
    expect(normalizeEventDate('2026-05-24')).toBe('2026-05-24T12:00:00.000Z');
  });
  it('passes a full datetime through unchanged (edit path already sends one)', () => {
    expect(normalizeEventDate('2026-05-24T16:00:00.000Z')).toBe('2026-05-24T16:00:00.000Z');
  });
  it('returns null for empty/nullish (caller falls back to now())', () => {
    expect(normalizeEventDate('')).toBeNull();
    expect(normalizeEventDate(null)).toBeNull();
    expect(normalizeEventDate(undefined)).toBeNull();
  });
  it('returns null for an unparseable value', () => {
    expect(normalizeEventDate('not-a-date')).toBeNull();
  });
});

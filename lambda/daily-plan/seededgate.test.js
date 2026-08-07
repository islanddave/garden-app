// BUG-SEEDEDGATE-001 — cadence provenance moves out of band (v_resolved_care.cadence_scopes).
//
// THE DEFECT: resolveCadence adopted a DB-resolved cadence only when the merged profile carried an
// in-payload `_seeded` marker. Nine cultivar care_profile rows carry a DIFFERENT marker —
// `_source: cowork_care_audit_20260709` on eight, `source: dave_confirmed` on Collards — so their
// researched intervals were invisible and six live plantings watered on bundled-JSON guesses while
// their own high-confidence numbers sat unread (Jade 12d read as 16d, Chives 4d read as 3d).
//
// THE FIX reads `cadence_scopes`: the scopes that contributed a NON-NULL watering interval.
// It does NOT read `resolved_scopes`, which only says a row EXISTS.
//
// Fixtures are verbatim live prod shapes read 2026-08-07, after 0a-view.sql was applied to prod:
//   Collards        resolved_scopes {system,cultivar}   cadence_scopes {}          -> bundled
//   the six movers  resolved_scopes {system,cultivar}   cadence_scopes {cultivar}  -> db
// That single divergent row is the entire reason the view carries two columns.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import engine from './engine.js';
import cad from './cadence-data-v2.json';

const { resolveCadence, waterSuppression } = engine;
const here = dirname(fileURLToPath(import.meta.url));
const ENGINE = readFileSync(join(here, 'engine.js'), 'utf8');
const HANDLER = readFileSync(join(here, 'handler.js'), 'utf8').replace(/\s+/g, ' ');

// Live care_profile payloads. Provenance markers are verbatim — note NONE of them is `_seeded`.
const CHIVES = { _source: 'cowork_care_audit_20260709', crop: 'herb (chives / Allium schoenoprasum)',
  drought_tolerance: 'low', water_interval_days: 4, water_interval_days_container: 4,
  water_interval_days_inground: null, fertilize_interval_days: 21 };
const JADE = { _source: 'cowork_care_audit_20260709', crop: 'succulent (jade / Crassula ovata)',
  drought_tolerance: 'high', water_interval_days: 12, water_interval_days_container: 12,
  water_interval_days_inground: null, fertilize_interval_days: 45 };
// Collards: the cultivar row EXISTS (so resolved_scopes is {system,cultivar}) and carries container
// sizing ONLY. It has no *_container key at all, so adopting it would land on cad.default = 3.
const COLLARDS = { source: 'dave_confirmed', crop: 'collard (Brassica oleracea, Acephala group)',
  _scope_note: 'container-sizing only; watering/thresholds intentionally omitted so resolution still falls to system default (no behavior change)',
  container_type: 'fabric_grow_bag', water_amount_ml: 250, water_interval_days: 3,
  fertilize_interval_days: 14 };

describe('BUG-SEEDEDGATE-001: adoption keys on cadence_scopes, not on a payload marker', () => {
  it('adopts an UNSEEDED profile when a scope contributed a cadence key (the whole ticket)', () => {
    const c = resolveCadence({ name: 'Chives', variety: 'Chives', genus: 'Allium',
      db_cadence: CHIVES, cadence_scopes: ['cultivar'] }, cad);
    expect(c._via).toBe('db');
    expect(c.water_interval_days_container).toBe(4);   // prod read 3 via genus:Allium
  });

  it("Jade Plant moves 16 -> 12: the researched profile beats the genus fallback", () => {
    const off = resolveCadence({ name: 'Jade Plant', variety: 'Crassula ovata', genus: 'Crassula',
      db_cadence: JADE, cadence_scopes: null }, cad);
    const on = resolveCadence({ name: 'Jade Plant', variety: 'Crassula ovata', genus: 'Crassula',
      db_cadence: JADE, cadence_scopes: ['cultivar'] }, cad);
    expect(off._via).toBe('genus:Crassula');
    expect(off.water_interval_days_container).toBe(16);
    expect(on._via).toBe('db');
    expect(on.water_interval_days_container).toBe(12);  // the only planting that GAINS a task on flip day
  });

  // ── THE TRAP ─────────────────────────────────────────────────────────────────────────────────
  it('COLLARDS: a cultivar row that exists but contributes NO cadence key is NOT adopted', () => {
    const c = resolveCadence({ name: 'Collards', variety: 'Collards', genus: 'Brassica',
      db_cadence: COLLARDS, cadence_scopes: [], resolved_scopes: ['system', 'cultivar'] }, cad);
    expect(c._via).toBe('genus:Brassica');              // NOT 'db'
    expect(c.water_interval_days_container).toBe(2);    // NOT 3 — the regression this test exists for
  });

  it('reads cadence_scopes and IGNORES resolved_scopes entirely', () => {
    // Same row, resolved_scopes populated three deep. If the resolver ever keys on that column
    // instead, this reds — and Collards silently loses a day of watering against its author's
    // written intent.
    const c = resolveCadence({ name: 'Collards', variety: 'Collards', genus: 'Brassica',
      db_cadence: COLLARDS, cadence_scopes: [],
      resolved_scopes: ['system', 'cultivar', 'leaf'] }, cad);
    expect(c._via).toBe('genus:Brassica');
  });

  it('flag OFF (cadence_scopes null/absent) is byte-identical to the pre-change resolver', () => {
    for (const cs of [null, undefined]) {
      // unseeded -> bundled, exactly as before
      expect(resolveCadence({ name: 'Chives', variety: 'Chives', genus: 'Allium',
        db_cadence: CHIVES, cadence_scopes: cs }, cad)._via).toBe('genus:Allium');
      // seeded -> db, exactly as before
      expect(resolveCadence({ variety: 'Cayenne', genus: 'Capsicum',
        db_cadence: { _seeded: true, crop: 'x', water_interval_days_container: 1 },
        cadence_scopes: cs }, cad)._via).toBe('db');
    }
  });

  it('a non-array cadence_scopes fails SAFE to the flag-OFF answer', () => {
    // If the driver ever hands text[] back unparsed as '{cultivar}', degrade to the old answer —
    // never to a wrong interval. The handler logs the array count so the degradation is visible.
    expect(resolveCadence({ name: 'Chives', variety: 'Chives', genus: 'Allium',
      db_cadence: CHIVES, cadence_scopes: '{cultivar}' }, cad)._via).toBe('genus:Allium');
  });

  it('with the flag ON, _seeded alone no longer adopts — structure is the only authority', () => {
    // Empty on prod today (zero seeded-but-not-cadence-bearing rows, verified), so the 150 seeded
    // rows are a strict SUBSET of the 158 bearing ones and nothing that resolves _via db stops.
    // Pinned anyway: it is the invariant the eventual flag-cleanup slice relies on.
    const c = resolveCadence({ name: 'Collards', variety: 'Collards', genus: 'Brassica',
      db_cadence: { ...COLLARDS, _seeded: true }, cadence_scopes: [] }, cad);
    expect(c._via).toBe('genus:Brassica');
  });
});

describe('the raw db_cadence suppression read is NOT made dead by this fix', () => {
  it('a profile declaring no_calendar_water but NO interval still suppresses', () => {
    // DRG-NOCALWATER-001. The Lithops class is exactly "signals present, cadence key absent" =>
    // cadence_scopes [] => bundled fallback. If waterSuppression were narrowed to read only the
    // RESOLVED cadence, this planting would be watered during dormancy — which is what killed the
    // original plant. Deleting that raw read as "now redundant" is the trap.
    const prof = { crop: 'succulent (living stone)', no_calendar_water: true, water_rule: 'growth_gated' };
    const c = resolveCadence({ variety: 'X', db_cadence: prof, cadence_scopes: [] }, cad);
    expect(c._via).not.toBe('db');
    expect(waterSuppression({ db_cadence: prof, cadence_scopes: [] }, c)).toBe('no_calendar_water');
  });
});

describe('anti-drift source guards', () => {
  it('NEGATIVE: the old sole-authority _seeded gate is gone (a revert cannot ship green)', () => {
    // Exact pre-change text of engine.js:32; grep -c was 1 before the fix and is 0 after. Pinning
    // the ABSENCE is what stops a revert passing — asserting only the new form would not.
    expect(ENGINE).not.toMatch(/if\(p && p\.db_cadence && p\.db_cadence\._seeded\) return/);
  });

  it('the resolver branches on an ARRAY-shaped cadence_scopes', () => {
    expect(ENGINE).toMatch(/const cs = p && p\.cadence_scopes/);
    expect(ENGINE).toMatch(/Array\.isArray\(cs\)/);
  });

  it('the resolver never READS resolved_scopes', () => {
    // Comments mention it (they must — it is the trap being documented), so assert on code shape:
    // no property access, no destructure.
    expect(ENGINE).not.toMatch(/[.[]\s*['"]?resolved_scopes['"]?\s*[\]);,]/);
  });

  it('the nightly query selects vrc.cadence_scopes', () => {
    expect(HANDLER).toMatch(/vrc\.cadence_scopes/);
  });

  it('the flag exists and OFF is applied by nulling the column, not by an engine branch', () => {
    // A threaded parameter would be one missed call site away from the same planting resolving two
    // different ways in one run — resolveCadence has four callers.
    expect(HANDLER).toMatch(/process\.env\.CARE_CADENCE_SCOPES_ENABLED === 'true'/);
    expect(HANDLER).toMatch(/p\.cadence_scopes = null/);
  });
});

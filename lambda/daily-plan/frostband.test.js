// BUG-STABLEUNKNOWNSLUGS-001 + BUG-PINEAPPLESAGEBAND-001 — the nine cultivars the 2026-09-18 frost
// census and v4.137.1's Stable change put in question, pinned in BOTH cold channels.
//
//   EMAIL  — frostClass.summarize, the naming predicate the frost alert is built from (handler.js
//            calls it with cadenceTenderFor, reproduced here), plus one frostEval night end to end.
//   CARD   — engine.generatePlan -> tasks.cold, the real call site of coldFor.
//
// Fixtures are the planting shape handler.js selects, with the values read on prod 2026-09-18, AFTER
// migrations/v5-frostband-001 (Autumn Fire typed hylotelephium, Pineapple Sage typed pineapple_sage and
// its care-profile cold block corrected). cadence_scopes is ['cultivar'] because
// CARE_CADENCE_SCOPES_ENABLED is true in prod (scripts/lambda-config-expected.json), so the engine adopts
// each DB profile — which is exactly why Pineapple Sage's garden-sage clone silenced its card.
//
// The unit suite mocks SQL: nothing here proves the migration applied or the rows exist. The
// migration's own gates do that (migrations/v5-frostband-001/gates.yml). The last describe block binds
// this file to that migration, so the fixtures cannot drift from what it writes.
//
// V5-BAYCOLD-001 (2026-10-09) adds a tenth planting, Sweet Bay Laurel, in its own three describe blocks at
// the end of this file: an UNCERTAIN slug (`bay`, unbanded on purpose) whose only frost signal is the cold
// block migrations/v5-baycold-001 writes onto its cultivar care profile. Its fixture value is parsed out of
// that migration's 0a too. The nine above are untouched by it.
//
// MUTATION LOG — 2026-09-18, lane-frostband-20260918. Each applied to ONE file, this file run, RED
// observed, file restored byte-for-byte (sha256 checked). Baseline 47 green.
//   M1  pineapple_sage dropped from the tender band                        -> 2 RED (band pin, migration binding)
//   M2  pineapple_sage moved to hardy                                     -> 7 RED
//   M3  hylotelephium dropped from hardy                                  -> 5 RED
//   M4  horseweed dropped from hardy                                      -> 5 RED
//   M5  sedum banded hardy (and dropped from UNCERTAIN_SLUGS)             -> 7 RED
//   M5b sedum banded hardy, UNCERTAIN_SLUGS left alone                    -> 7 RED
//   M6  succulent banded hardy                                            -> 7 RED
//   M7  cactus banded hardy                                               -> 5 RED
//   M8  the 'pineapple sage' label dropped                                -> 2 RED
//   M9  0a writes the garden-sage clone cold block instead                -> 4 RED
//   M10 0a re-types Pineapple Sage to a typo'd slug                       -> 2 RED
//   M11 0b-derive.mjs forgets Autumn Fire                                 -> 1 RED
//   M12 engine.coldFor adopts a tender:false profile                      -> 2 RED
//   M13 summarize stops skipping hardy slugs                              -> 5 RED
// M1 is only 2 because the corrected care profile ALSO names Pineapple Sage through the handler's cadence
// promotion: with its band deleted it still reaches the email as tender. That is the belt-and-braces the
// window test below pins, and the band pin is what still catches the deletion.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import engine from './engine.js';
import cad from './cadence-data-v2.json';
import fm from './fertilization-model.json';
import fc from './frostClass.js';
import fe from './frostEval.js';

const { generatePlan, resolveCadence } = engine;
const { summarize, frostClassForSlug, SLUGS_BY_BAND, UNCERTAIN_SLUGS, BAND_BY_SLUG, BAND_THRESHOLDS } = fc;
const { frostEval } = fe;

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(here, '..', '..', 'migrations', 'v5-frostband-001');
const stripSqlComments = (sql) => sql.replace(/--[^\n]*/g, '');
const SQL_0A = stripSqlComments(readFileSync(join(MIGRATION, '0a-data.sql'), 'utf8'));
const DERIVE_0B = readFileSync(join(MIGRATION, '0b-derive.mjs'), 'utf8');

// The cold block 0a writes onto Pineapple Sage's cultivar care profile, parsed out of the migration
// rather than retyped, so the card fixture below is always the value the migration actually writes.
const PS_COLD_AFTER = JSON.parse(SQL_0A.match(/jsonb_set\(profile, '\{cold\}', '(\{[^']*\})'::jsonb/)[1]);
const PS_COLD_CLONE = { tender: false, protect_below_F: 10 };   // garden sage's, via cadence-backfill-20260823

const STABLE = { frost_covered_resolved: true, heated_resolved: false };     // covered, UNHEATED
const BAG_AREA = { frost_covered_resolved: false, heated_resolved: false };  // open sky

const pot = (id, name, variety, slug, genus, where, db, extra = {}) => ({
  id, name, variety, crop_type_slug: slug, genus, container_type: 'plastic_pot', status: 'vegetative',
  ...where, db_cadence: db, cadence_scopes: ['cultivar'], last_brought_inside: null, last_brought_outside: null,
  ...extra,
});

// Resolved profiles: the keys resolveCadence/coldFor read, as read on prod. None of the eight but
// Pineapple Sage carries a `cold` key at all.
const DB = {
  sedum: { crop: 'sedum', water_interval_days_container: 12, water_method: 'soak_then_dry', indoor: true },
  horseweed: { crop: 'horseweed', water_interval_days_container: 7, no_calendar_feed: true },
  cactus: { crop: 'cactus (Gymnocalycium mihanovichii moon cactus, grafted)', water_interval_days_container: 14 },
  sedumTender: { crop: 'succulent (Sedum)', water_interval_days_container: 12 },
  succulent: { crop: 'succulent', water_interval_days_container: 12 },
  succulentGeneric: { crop: 'succulent (generic)', water_interval_days_container: 12 },
  pineappleSage: (cold) => ({ crop: 'sage', cold, water_interval_days_container: 5, water_interval_days_inground: 7,
    water_method: 'soak_then_dry', fertilize_interval_days: 30 }),
};

// Post-migration. Autumn Fire's brought_inside (logged 2026-09-17) is left OFF here on purpose, so these
// fixtures prove the CLASSIFICATION and not the indoors toggle; the toggle has its own test below.
const AUTUMN_FIRE = pot('29de7a55-7bbb-48b5-b2b0-60e62abae6f0', 'Autumn Fire Stonecrop', 'Sedum spectabile',
  'hylotelephium', null, STABLE, DB.sedum);
const HORSEWEED = pot('dd52796c-5868-4da1-a117-ce28879c0f02', 'Horseweed', 'Horseweed', 'horseweed', null, STABLE,
  DB.horseweed, { status: 'flowering' });
const PINEAPPLE_SAGE = pot('e37ab48c-f68e-448f-a6aa-fe016ecaf4fd', 'Pineapple Sage', 'Pineapple Sage',
  'pineapple_sage', 'Salvia', BAG_AREA, DB.pineappleSage(PS_COLD_AFTER));
const TENDER_SIX = [
  pot('2f5a4c13-a290-42c0-b98f-e255cb1ce011', 'Gymnocalycium mihanovichii', 'Gymnocalycium mihanovichii', 'cactus',
    'Gymnocalycium', STABLE, DB.cactus),
  // The planting is "Copper Stonecrop" but its variety row is "Golden Sedum" (S. adolphii): a data oddity,
  // reported, not fixed. Both are zone-10 tender, so the answer is the same either way.
  pot('e8b50372-454b-4b33-a932-21ab144f20f9', 'Copper Stonecrop', 'Golden Sedum', 'sedum', 'Sedum', STABLE, DB.sedumTender),
  pot('51086591-9b7a-413f-a3fe-2c0d3d37c0af', 'Golden Sedum', 'Golden Sedum', 'sedum', 'Sedum', STABLE, DB.sedumTender),
  pot('931f80a6-9262-483f-9a38-e1a98144194a', 'Graptosedum', 'Graptosedum', 'succulent', null, STABLE, DB.succulent),
  pot('0935edd3-1ddb-41d7-b2b9-3c3beeeecd9e', "Love's Fire", "Love's Fire", 'succulent', 'Echeveria', STABLE,
    DB.succulentGeneric),
  pot('fdeb1317-6b11-4ac9-8289-75f3ac758a56', 'Pachyphytum', 'Pachyphytum', 'succulent', null, STABLE, DB.succulent),
];
const NINE = [AUTUMN_FIRE, HORSEWEED, PINEAPPLE_SAGE, ...TENDER_SIX];

// ── channel helpers ──────────────────────────────────────────────────────────────────────────────────
// handler.js's own promotion input, reproduced verbatim: cadence cold.tender can lift an UNKNOWN slug.
const cadenceTenderFor = (p) => { const c = resolveCadence(p, cad); return !!(c && c.cold && c.cold.tender); };
const exposureOf = (rows) => summarize(rows, { cadenceTenderFor });
const named = (p) => exposureOf([p]).atRisk === 1;

// frostAlertEnabled: prod's live value. Same helper shape as coldcardreachable.test.js.
const planFor = (ps, low) => generatePlan({
  plantings: ps.map((p) => ({ project: 'Garden', project_id: 'pg', substrate_start: '2026-05-01',
    last_water: '2026-09-17', last_fert: null, ...p })),
  cadence: cad, fertModel: fm, today: '2026-09-18', weather: { unit: 'F', tonightLow: low, highToday: low + 20 },
  ownerFallback: 'dave', frostAlertEnabled: true,
});
const card = (p, low) => Object.values(planFor([p], low).users).flatMap((u) => u.tasks.cold)
  .find((r) => r.name === p.name) || null;
const LOWS = [60, 55, 50, 45, 41, 40, 38, 36, 33, 32, 31, 28, 20, 10];
const carded = (p) => LOWS.filter((low) => card(p, low));

describe('EMAIL — which of the nine the frost alert names', () => {
  it.each([
    ['Autumn Fire Stonecrop', AUTUMN_FIRE, { named: false, class: 'hardy', band: 'hardy' }],
    ['Horseweed', HORSEWEED, { named: false, class: 'hardy', band: 'hardy' }],
    ['Pineapple Sage', PINEAPPLE_SAGE, { named: true, class: 'tender', band: 'tender' }],
    ...TENDER_SIX.map((p) => [p.name, p, { named: true, class: 'unknown', band: 'tender' }]),
  ])('%s', (_n, p, want) => {
    const r = frostClassForSlug(p.crop_type_slug);
    expect({ named: named(p), class: r.class, band: r.band }).toEqual(want);
  });

  it('as one exposure: 7 named, 2 hardy; Pineapple Sage by name, the tender six as "unclassified"', () => {
    const s = exposureOf(NINE);
    expect({ atRisk: s.atRisk, tender: s.tender, unknown: s.unknown, hardy: s.hardy }).toEqual({ atRisk: 7, tender: 1, unknown: 6, hardy: 2 });
    expect(s.byCropType.map((g) => [g.label, g.count])).toEqual([['unclassified', 6], ['pineapple sage', 1]]);
    expect(s.unknownSlugs).toEqual(['cactus', 'sedum', 'succulent']);
    const everyName = [...s.tenderPlantings, ...s.unknownPlantings].map((x) => x.name);
    expect(everyName).not.toContain('Autumn Fire Stonecrop');
    expect(everyName).not.toContain('Horseweed');
  });

  it('Pineapple Sage trips at the tender baseline (40 / 38 / 33), the same line as the tomatoes', () => {
    const g = exposureOf([PINEAPPLE_SAGE]).byCropType[0];
    expect(g.thresholds).toEqual(BAND_THRESHOLDS.tender);
    expect(g.thresholds).toEqual(frostClassForSlug('tomato').thresholds);
  });

  it('a 36F night end to end: the message names pineapple sage and counts the six, never horseweed or the stonecrop', () => {
    const d = frostEval({ tonightLow: 36, exposure: exposureOf(NINE) }, {});
    expect(d.alert).toBe(true);
    expect(d.message).toContain('pineapple sage (1)');
    expect(d.message).toContain('6 unclassified (treated as tender)');
    expect(d.message).not.toMatch(/horseweed|hylotelephium|stonecrop/i);
  });

  it('a 36F night with ONLY the two false alarms left sends nothing', () => {
    const d = frostEval({ tonightLow: 36, exposure: exposureOf([AUTUMN_FIRE, HORSEWEED]) }, {});
    expect(d.alert).toBe(false);
  });
});

describe('CARD — what the cold card does for each of the nine, 60F down to 10F', () => {
  it('Pineapple Sage: a bring-in card at 32F and below, nothing above (its corrected care profile)', () => {
    expect(carded(PINEAPPLE_SAGE)).toEqual([32, 31, 28, 20, 10]);
    expect(card(PINEAPPLE_SAGE, 31)).toMatchObject({ level: 'protect' });
  });

  it('Pineapple Sage logged as brought inside: no card at any temperature', () => {
    expect(carded({ ...PINEAPPLE_SAGE, last_brought_inside: '2026-09-18' })).toEqual([]);
  });

  it('the flag-OFF resolution agrees: no DB profile adopted -> bundled Salvia genus fallback -> same 32F card', () => {
    // CARE_CADENCE_SCOPES_ENABLED off nulls cadence_scopes; the profile carries no _seeded marker, so
    // resolveCadence falls through to cadence-data-v2.json by_genus_fallback.Salvia (authored for S. elegans).
    expect(carded({ ...PINEAPPLE_SAGE, cadence_scopes: null })).toEqual([32, 31, 28, 20, 10]);
  });

  it.each([AUTUMN_FIRE, HORSEWEED].map((p) => [p.name, p]))('%s: never carded (hardy)', (_n, p) => {
    expect(carded(p)).toEqual([]);
  });

  it.each(TENDER_SIX.map((p) => [p.name, p]))('%s: never carded — named by the email, no bring-in threshold on its adopted profile', (_n, p) => {
    // The accepted state engine.coldFor records (BUG-COLDCARDDISCARD-001): these carry no protect_below_F
    // on the profile the engine adopts, so the frost email is their channel. Silence here is "no
    // threshold", never a hardy claim — the agreement block below checks exactly that distinction.
    expect(carded(p)).toEqual([]);
  });

  it('instrument check: every "never carded" fixture DOES reach coldFor — a 40F tender profile cards each one', () => {
    // Without this, a fixture generatePlan silently skipped would pass every "never carded" test above.
    for (const p of [AUTUMN_FIRE, HORSEWEED, ...TENDER_SIX]) {
      const probe = { ...p, db_cadence: { ...p.db_cadence, cold: { tender: true, protect_below_F: 40 } } };
      expect(carded(probe), p.name).toEqual([40, 38, 36, 33, 32, 31, 28, 20, 10]);
    }
  });
});

describe('the two channels agree for all nine', () => {
  // A channel "calls it hardy" when the email leaves it out, or when the profile the card path adopts
  // states tender:false. The two must never disagree: that was Pineapple Sage in both directions at once
  // (email: sage -> hardy; card: garden-sage clone -> hardy to 10F), and fixing only the band would have
  // left the card saying the opposite of the email.
  const cardSaysHardy = (p) => { const c = resolveCadence(p, cad); return !!(c && c.cold && c.cold.tender === false); };

  it.each(NINE.map((p) => [p.name, p]))('%s', (_n, p) => {
    if (named(p)) {
      expect(cardSaysHardy(p), 'named by the email, but the card path adopts a hardy cold profile').toBe(false);
    } else {
      expect(carded(p), 'left out of the email, but carded').toEqual([]);
    }
  });

  it('the pre-migration Pineapple Sage profile is exactly the disagreement this guards against', () => {
    const clone = { ...PINEAPPLE_SAGE, db_cadence: DB.pineappleSage(PS_COLD_CLONE) };
    expect(named(clone)).toBe(true);           // the new band names it...
    expect(cardSaysHardy(clone)).toBe(true);   // ...while the clone profile calls it hardy
    expect(carded(clone)).toEqual([]);         // ...and the card stays silent at 10F
  });
});

describe('guard: sedum / succulent / cactus are NEVER banded hardy', () => {
  // Banding any of these hardy would silence the six tender plants above in the same stroke that
  // silenced a false alarm. The hardy members get their own slug instead (hylotelephium, sempervivum).
  it.each(['sedum', 'succulent', 'cactus'])('%s stays unmapped, counted tender', (slug) => {
    expect(SLUGS_BY_BAND.hardy).not.toContain(slug);
    expect(BAND_BY_SLUG[slug]).toBeUndefined();
    expect(UNCERTAIN_SLUGS).toContain(slug);
    expect(frostClassForSlug(slug)).toMatchObject({ class: 'unknown', countedAs: 'tender' });
  });

  it('all six tender plantings stay named', () => {
    const s = exposureOf(TENDER_SIX);
    expect(s.atRisk).toBe(6);
    expect(s.unknownPlantings.map((x) => x.name).sort()).toEqual(TENDER_SIX.map((p) => p.name).sort());
  });
});

describe('window — BEFORE the migration applies, this code behaves as today', () => {
  // The code ships independently of v5-frostband-001. Until the data lands, the two cultivars still
  // carry their old slugs and Pineapple Sage its clone profile: Horseweed is fixed at once, the other
  // two are unchanged. This pins that the code alone moves nothing else.
  it('Autumn Fire on `sedum`: still named, as "unclassified"', () => {
    expect(named({ ...AUTUMN_FIRE, crop_type_slug: 'sedum' })).toBe(true);
  });
  it('Pineapple Sage on `sage` with the clone profile: still hardy in both channels (the defect, until the apply)', () => {
    const pre = { ...PINEAPPLE_SAGE, crop_type_slug: 'sage', db_cadence: DB.pineappleSage(PS_COLD_CLONE) };
    expect(named(pre)).toBe(false);
    expect(carded(pre)).toEqual([]);
  });
  it('Horseweed is fixed by the code alone: its slug is its own, no data change', () => {
    expect(named(HORSEWEED)).toBe(false);
  });
  it('AFTER the data, BEFORE this code: the corrected profile alone gets Pineapple Sage named', () => {
    // The deployed classifier does not know `pineapple_sage`; a slug it has never seen stands in for that.
    // handler.js's cadenceTenderFor promotes an unknown slug when the adopted profile says tender, which the
    // corrected cold block does — so the email warns for it in that window too, as tender, not "unclassified".
    const unknownToOldCode = { ...PINEAPPLE_SAGE, crop_type_slug: 'slug_the_deployed_code_never_saw' };
    const s = exposureOf([unknownToOldCode]);
    expect({ atRisk: s.atRisk, tender: s.tender, unknown: s.unknown }).toEqual({ atRisk: 1, tender: 1, unknown: 0 });
  });
});

describe('the migration and the code agree (migrations/v5-frostband-001)', () => {
  const minted = [...SQL_0A.matchAll(/INSERT INTO public\.crop_types[\s\S]*?(?:VALUES\s*\(|SELECT)\s*'([a-z0-9_]+)'/g)]
    .map((m) => m[1]);
  const retypes = [...SQL_0A.matchAll(
    /UPDATE public\.plant_varieties SET crop_type_slug = '([a-z0-9_]+)'[^;]*?WHERE id = '([0-9a-f-]{36})' AND crop_type_slug = '([a-z0-9_]+)'/g)]
    .map((m) => ({ id: m[2], from: m[3], to: m[1] }));

  it('every crop type the migration mints is banded, in the band this lane decided', () => {
    expect(minted.sort()).toEqual(['hylotelephium', 'pineapple_sage']);
    expect(BAND_BY_SLUG.hylotelephium).toBe('hardy');
    expect(BAND_BY_SLUG.pineapple_sage).toBe('tender');
  });

  it('it re-types exactly the two cultivars, by id, each guarded on its old slug', () => {
    expect(retypes).toEqual([
      { id: '44907632-80f4-4f8d-bbdd-e7143e0bea7a', from: 'sedum', to: 'hylotelephium' },
      { id: '6b75492d-b08c-4f66-9de9-18157fc1bdaa', from: 'sage', to: 'pineapple_sage' },
    ]);
    // ...and the fixtures above sit on the slugs it writes.
    expect(AUTUMN_FIRE.crop_type_slug).toBe(retypes[0].to);
    expect(PINEAPPLE_SAGE.crop_type_slug).toBe(retypes[1].to);
  });

  it('0b-derive.mjs derives tags for exactly the cultivars 0a re-types, onto the same slugs', () => {
    const moved = [...DERIVE_0B.matchAll(/\['([0-9a-f-]{36})',\s*'([a-z0-9_]+)'/g)].map((m) => ({ id: m[1], to: m[2] }));
    expect(moved).toEqual(retypes.map(({ id, to }) => ({ id, to })));
  });

  it("the cold block it writes is the bundled S. elegans value, and it is tender", () => {
    expect(PS_COLD_AFTER).toEqual(cad.by_genus_fallback.Salvia.cold);
    expect(PS_COLD_AFTER.tender).toBe(true);
  });
});

// ── V5-BAYCOLD-001 — Sweet Bay Laurel (Dave, 2026-10-09: warn it, protect below 32F) ─────────────────────
// `bay` is unbanded ON PURPOSE (frostClass.UNCERTAIN_SLUGS) and has no threshold on any source surface: no
// crop-type entry, no bundled variety or genus entry. So before migrations/v5-baycold-001 the email counted
// the planting inside "unclassified" without naming it, and the card never fired. The migration adds one
// key, `cold`, to the cultivar care profile the engine adopts. No code moves, and `bay` stays uncertain.
//
// Fixture: the planting shape handler.js selects, as read on prod 2026-10-09 — potted, in the Trough (open
// sky, unheated), cadence_scopes ['cultivar'], no brought_inside event. The profile keys are the two the
// engine reads here (crop "bay" and the 2-day container interval, both on the 09-24 plan row in
// tests/harness/_todaymeasure/dailyplan.dave.json). Genus was not read and is left null; nothing keys on
// it for bay (the instrument check shows 'Laurus' resolves the same).
//
// MUTATION LOG — 2026-10-09, lane-baycold-20261009. Each applied to ONE file, this file run (with
// frostClass.test.js for B18-B20, counts across both), RED observed, the file restored byte-for-byte
// (sha256 checked). Baseline 80 green here, 174 across the two.
//   B1  0a writes 33 instead of 32                                        -> 9 RED
//   B2  0a loses the `AND NOT (profile ? 'cold')` guard                   -> 19 RED
//   B3  0a create_missing false (matches the row, writes nothing)         -> 1 RED
//   B4  0a merges a whole object (profile || ...) instead of jsonb_set    -> 20 RED
//   B5  0a keyed by row id only, (scope, scope_id) dropped                -> 19 RED
//   B6  0a writes tender:false                                            -> 18 RED
//   B7  0a stamps a different version                                     -> 1 RED
//   B8  0a gains a second UPDATE on another key                           -> 1 RED
//   B9  0r matches 33 instead of what 0a wrote                            -> 1 RED
//   B10 0r loses its stamp guard                                          -> 1 RED
//   B11 gates: the standing floor lowered to 30                           -> 1 RED
//   B12 gates: the standing invariant demoted to continuous: false        -> 1 RED
//   B13 gates: the standing invariant loses env: prod                     -> 1 RED
//   B14 gates: the value receipt says 33                                  -> 1 RED
//   B15 gates: the pre gate's md5 differs                                 -> 1 RED
//   B16 gates: the premise gate stops requiring cadence_scopes {cultivar} -> 1 RED
//   B17 gates: the standing invariant loses its self-arming stamp check   -> 1 RED
//   B18 frostClass: bay dropped from UNCERTAIN_SLUGS                      -> 2 RED (1 here, 1 in frostClass.test.js)
//   B19 frostClass: bay banded hardy                                      -> 14 RED
//   B20 frostClass: the cadence promotion removed                         -> 13 RED
//   B21 engine.coldFor: low < threshold instead of <=                     -> 7 RED
//   B22 engine.resolveCadence never adopts the database profile           -> 22 RED
const BAY_MIGRATION = join(here, '..', '..', 'migrations', 'v5-baycold-001');
const BAY_SQL_0A = stripSqlComments(readFileSync(join(BAY_MIGRATION, '0a-data.sql'), 'utf8'));
const BAY_SQL_0R = stripSqlComments(readFileSync(join(BAY_MIGRATION, '0r-rollback.sql'), 'utf8'));
const BAY_GATES = readFileSync(join(BAY_MIGRATION, 'gates.yml'), 'utf8');
const BAY_STAMP = '5.0.0-baycold-001';
const BAY_ROW = 'd4c8c7e3-320c-4019-8827-b39894cf02b8';        // care_profile row
const BAY_CULTIVAR = 'e890276d-43e6-41cd-9dfe-1fa8e05fcfc1';   // plant_varieties "Sweet Bay"
const BAY_PLANTING = '0bf82c76-b7c2-4396-bc17-9f95f5138806';   // plants "Sweet Bay Laurel"
const BAY_MD5_BEFORE = 'ae1f9608920cf706635dc726cdd44fe8';     // md5(profile::text), prod 2026-10-09
const BAY_DECIDED = { tender: true, protect_below_F: 32 };     // the decision: there is no bundled entry to copy

// Every care_profile UPDATE in 0a, in the coldcards.test.js shape. The id + (scope, scope_id) key, the
// absent-key guard and the create_missing flag are part of the pattern: an UPDATE that loses any of them no
// longer matches, the fixture below loses its cold block, and the binding and card tests go red together.
const BAY_UPDATES = [...BAY_SQL_0A.matchAll(
  /UPDATE public\.care_profile\s+SET profile = jsonb_set\(profile, '\{cold\}', '(\{[^']*\})'::jsonb, (true|false)\),\s*updated_at = now\(\)\s+WHERE id = '([0-9a-f-]{36})'\s+AND scope = 'cultivar' AND scope_id = '([0-9a-f-]{36})'\s+AND NOT \(profile \? 'cold'\);/g)]
  .map((m) => ({ row: m[3], cultivar: m[4], cold: JSON.parse(m[1]), createMissing: m[2] }));
// The cold block the fixture carries is the one 0a writes, parsed, never retyped.
const BAY_COLD = BAY_UPDATES.length === 1 ? BAY_UPDATES[0].cold : undefined;

const TROUGH = { frost_covered_resolved: false, heated_resolved: false };   // open sky, unheated
const bayProfile = (cold) => ({ crop: 'bay', water_interval_days_container: 2, ...(cold ? { cold } : {}) });
const BAY_BEFORE = pot(BAY_PLANTING, 'Sweet Bay Laurel', 'Sweet Bay', 'bay', null, TROUGH, bayProfile(null));
const BAY = pot(BAY_PLANTING, 'Sweet Bay Laurel', 'Sweet Bay', 'bay', null, TROUGH, bayProfile(BAY_COLD));
const BAY_NIGHTS = LOWS.filter((low) => low <= 32);   // [32, 31, 28, 20, 10]

const BAY_GATE_NAMES = [...BAY_GATES.matchAll(/- name: (\S+)\n/g)].map((m) => m[1]);
// One gate's text, from its `- name:` line to the next gate's.
const bayGate = (name) => {
  const i = BAY_GATES.indexOf(`- name: ${name}\n`);
  if (i < 0) throw new Error(`gate ${name} not found`);
  const j = BAY_GATES.indexOf('- name: ', i + 1);
  return BAY_GATES.slice(i, j < 0 ? undefined : j);
};

describe('V5-BAYCOLD-001 EMAIL — the frost alert names the bay, on the nights it already fired', () => {
  it('`bay` stays an UNCERTAIN slug: unbanded, no crop-type threshold, unknown without a cadence signal', () => {
    expect(UNCERTAIN_SLUGS).toContain('bay');
    expect(BAND_BY_SLUG.bay).toBeUndefined();
    expect(fc.coldProfileForSlug('bay')).toBeNull();
    expect(frostClassForSlug('bay')).toMatchObject({ class: 'unknown', countedAs: 'tender', source: 'unmapped' });
  });

  it('the adopted profile promotes it: class tender, source cadence, named "bays"', () => {
    expect(cadenceTenderFor(BAY)).toBe(true);
    expect(frostClassForSlug(BAY.crop_type_slug, { cadenceTender: cadenceTenderFor(BAY) }))
      .toMatchObject({ slug: 'bay', class: 'tender', countedAs: 'tender', source: 'cadence', label: 'bays' });
    const s = exposureOf([BAY]);
    expect({ atRisk: s.atRisk, tender: s.tender, unknown: s.unknown }).toEqual({ atRisk: 1, tender: 1, unknown: 0 });
    expect(s.byCropType.map((g) => [g.slug, g.label, g.count])).toEqual([['bay', 'bays', 1]]);
    expect(s.tenderPlantings.map((x) => [x.name, x.class, x.source])).toEqual([['Sweet Bay Laurel', 'tender', 'cadence']]);
    expect(s.unknownSlugs).toEqual([]);
  });

  it('BEFORE the apply (no `cold` key): counted at the tender trips, inside "unclassified", never named', () => {
    expect(cadenceTenderFor(BAY_BEFORE)).toBe(false);
    const s = exposureOf([BAY_BEFORE]);
    expect({ atRisk: s.atRisk, tender: s.tender, unknown: s.unknown }).toEqual({ atRisk: 1, tender: 0, unknown: 1 });
    expect(s.byCropType.map((g) => [g.slug, g.label, g.count])).toEqual([[null, 'unclassified', 1]]);
    expect(s.unknownSlugs).toEqual(['bay']);
  });

  it('the trip points do not move: unclassified and cadence-promoted both sit on the tender baseline (40 / 38 / 33)', () => {
    const before = exposureOf([BAY_BEFORE]).byCropType[0];
    const after = exposureOf([BAY]).byCropType[0];
    expect(after.thresholds).toEqual(before.thresholds);
    expect(after.thresholds).toEqual(BAND_THRESHOLDS.tender);
    expect(after.band).toBe(before.band);
  });

  it.each(LOWS)('a %i°F night: the alert fires or stays silent exactly as before, and only the wording names the bay', (low) => {
    const before = frostEval({ tonightLow: low, exposure: exposureOf([BAY_BEFORE]) }, {});
    const after = frostEval({ tonightLow: low, exposure: exposureOf([BAY]) }, {});
    expect({ alert: after.alert, tier: after.tier, level: after.level })
      .toEqual({ alert: before.alert, tier: before.tier, level: before.level });
    expect(after.alert).toBe(low <= BAND_THRESHOLDS.tender.IMMINENT_LOW_F);
    if (!after.alert) return;
    expect(after.message).toContain('bays (1)');
    expect(after.message).not.toContain('unclassified');
    expect(before.message).toContain('1 unclassified (treated as tender)');
    expect(before.message).not.toMatch(/\bbays?\b/i);
  });

  it('apply-day edge: on a night ALREADY alerted with the bay inside "unclassified", the newly named crop sends once more', () => {
    // frostEval.escalatesBeyond reads a crop no earlier send tripped as worse, so an apply that lands between
    // two evaluations of one alerted night costs one extra email naming the bay, and then it is quiet again.
    const sent = frostEval({ tonightLow: 36, exposure: exposureOf([BAY_BEFORE]) }, {});
    const now = frostEval({ tonightLow: 36, exposure: exposureOf([BAY]) }, {});
    expect(sent.cropLevels).toEqual({ unclassified: 'protect' });
    expect(now.cropLevels).toEqual({ bay: 'protect' });
    expect(now.dedupKey).not.toBe(sent.dedupKey);
    const stored = (d) => ({ tier: d.tier, level: d.level, crops: d.cropLevels });
    expect(fe.escalatesBeyond([stored(sent)], { level: now.level, crops: now.cropLevels })).toBe(true);
    expect(fe.escalatesBeyond([stored(sent), stored(now)], { level: now.level, crops: now.cropLevels })).toBe(false);
  });
});

describe('V5-BAYCOLD-001 CARD — a bring-in card at 32°F and below, none at 33°F', () => {
  it('generatePlan puts the card on tasks.cold at 32°F, and not one degree above', () => {
    expect(card(BAY, 33)).toBeNull();
    expect(card(BAY, 32)).toMatchObject({ name: 'Sweet Bay Laurel', level: 'protect' });
    expect(card(BAY, 32).text).toContain('≤ 32°F');
  });

  it('carded on exactly the nights at or below 32°F', () => {
    expect(carded(BAY)).toEqual(BAY_NIGHTS);
    expect(BAY_NIGHTS).toEqual([32, 31, 28, 20, 10]);
  });

  it('coldFor itself: {level: protect} at 32°F, null at 33°F', () => {
    expect(engine.coldFor(BAY, cad, 32, true, null)).toMatchObject({ level: 'protect' });
    expect(engine.coldFor(BAY, cad, 33, true, null)).toBeNull();
  });

  it('BEFORE the apply (no `cold` key): never carded, the defect', () => {
    expect(carded(BAY_BEFORE)).toEqual([]);
  });

  it('logged as brought inside: no card at any temperature', () => {
    expect(carded({ ...BAY, last_brought_inside: '2026-09-18' })).toEqual([]);
  });

  it('instrument check: the fixture takes the ADOPTED DATABASE PROFILE, and nothing bundled stands behind it', () => {
    expect(resolveCadence(BAY, cad)._via).toBe('db');
    expect(resolveCadence(BAY_BEFORE, cad)._via).toBe('db');
    for (const key of ['Sweet Bay', 'Sweet Bay Laurel']) expect(cad.by_variety[key], key).toBeUndefined();
    expect(cad.by_genus_fallback.Laurus).toBeUndefined();
    expect(cad.default.cold).toBeUndefined();
    // So with CARE_CADENCE_SCOPES_ENABLED off (the handler nulls cadence_scopes) the engine falls to the
    // bundled default and the bay is silent again: this fix lives in the database profile alone.
    for (const genus of [null, 'Laurus']) {
      expect(carded({ ...BAY, genus }), String(genus)).toEqual(BAY_NIGHTS);
      const flagOff = { ...BAY, genus, cadence_scopes: null };
      expect(resolveCadence(flagOff, cad)._via, String(genus)).toBe('default');
      expect(carded(flagOff), String(genus)).toEqual([]);
    }
  });
});

describe('the migration writes the decided value, and only that key, on the one row (migrations/v5-baycold-001)', () => {
  it('0a sets `cold` once: by row id AND (scope, scope_id), guarded on the key being absent, create_missing true', () => {
    expect(BAY_UPDATES).toEqual([{ row: BAY_ROW, cultivar: BAY_CULTIVAR, cold: BAY_DECIDED, createMissing: 'true' }]);
  });

  it('the value is the decided 32°F, tender: pinned directly, because no bundled entry exists to copy it from', () => {
    expect(BAY_COLD).toEqual({ tender: true, protect_below_F: 32 });
    expect(BAY.db_cadence.cold).toBe(BAY_COLD);   // the card fixture above carries what 0a writes
  });

  it('0a writes nothing else: one UPDATE, one single-key jsonb_set, the stamp, in one transaction', () => {
    expect(BAY_SQL_0A.match(/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+public\.\w+/g))
      .toEqual(['UPDATE public.care_profile', 'INSERT INTO public.schema_version']);
    expect((BAY_SQL_0A.match(/jsonb_set\(/g) || []).length).toBe(1);
    // never a whole-object replace or a merge: the only thing assigned to `profile` is the one-key jsonb_set
    expect(BAY_SQL_0A).not.toMatch(/SET\s+profile\s*=(?!\s*jsonb_set\(profile, '\{cold\}', )/);
    expect(BAY_SQL_0A).not.toContain('||');
    expect(BAY_SQL_0A).not.toMatch(/\b(?:ALTER|DROP|CREATE|TRUNCATE)\s/);
    expect(BAY_SQL_0A.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
  });

  it('the stamp is 5.0.0-baycold-001 in the house shape, and 0r deletes the same one', () => {
    expect(BAY_SQL_0A).toMatch(new RegExp(
      "INSERT INTO public\\.schema_version \\(version, description, applied_at\\)\\s+VALUES \\('5\\.0\\.0-baycold-001',"
      + '[\\s\\S]*?now\\(\\)\\)\\s+ON CONFLICT \\(version\\) DO UPDATE\\s+SET applied_at = now\\(\\), description = EXCLUDED\\.description;'));
    expect([...BAY_SQL_0A.matchAll(/'(\d+\.\d+\.\d+-[a-z0-9-]+)'/g)].map((m) => m[1])).toEqual([BAY_STAMP]);
    expect(BAY_SQL_0R).toContain(`DELETE FROM public.schema_version WHERE version = '${BAY_STAMP}';`);
  });

  it('0r removes only what 0a wrote: the same row, only while the key still holds that value and the stamp exists', () => {
    const rolledBack = [...BAY_SQL_0R.matchAll(
      /UPDATE public\.care_profile\s+SET profile = profile - 'cold', updated_at = now\(\)\s+WHERE id = '([0-9a-f-]{36})'\s+AND scope = 'cultivar' AND scope_id = '([0-9a-f-]{36})'\s+AND profile->'cold' = '(\{[^']*\})'::jsonb\s+AND EXISTS \(SELECT 1 FROM public\.schema_version WHERE version = '([^']+)'\);/g)]
      .map((m) => ({ row: m[1], cultivar: m[2], cold: JSON.parse(m[3]), stamp: m[4] }));
    expect(rolledBack).toEqual([{ row: BAY_ROW, cultivar: BAY_CULTIVAR, cold: BAY_COLD, stamp: BAY_STAMP }]);
    expect((BAY_SQL_0R.match(/UPDATE public\.care_profile/g) || []).length).toBe(1);
    expect(BAY_SQL_0R).toContain(`'${BAY_MD5_BEFORE}'`);
  });

  it('gates.yml: the pre gates, one standing invariant and the receipts, in that order', () => {
    expect(BAY_GATE_NAMES).toEqual([
      'pre_not_already_applied', 'pre_cultivar_is_the_row_read_at_authoring',
      'pre_profile_is_the_backfill_row_without_cold', 'pre_no_leaf_override_carries_cold',
      'pre_no_other_live_planting_reaches_this_row', 'pre_the_planting_is_live_potted_and_unheated',
      'pre_the_engine_adopts_a_profile_without_cold',
      'post_schema_version_recorded', 'post_no_db_profile_leaves_the_potted_bay_unwarned',
      'post_the_row_carries_the_decided_value', 'post_cold_fix_was_single_key_not_a_full_replace',
      'post_engine_view_of_the_planting_carries_the_cold_block',
    ]);
    // Exactly one post gate is continuous (carries no `continuous: false` key): the standing invariant.
    const post = BAY_GATE_NAMES.filter((n) => n.startsWith('post_'));
    expect(post.filter((n) => !/\n {4}continuous: false\n/.test(bayGate(n))))
      .toEqual(['post_no_db_profile_leaves_the_potted_bay_unwarned']);
    // Every gate that names a prod id is env: prod; the two that name none run on both.
    for (const name of BAY_GATE_NAMES) {
      const namesAnId = /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/.test(bayGate(name));
      expect(/\n {4}env: prod\n/.test(bayGate(name)), name).toBe(namesAnId);
    }
    expect(BAY_GATE_NAMES.filter((n) => !/\n {4}env: /.test(bayGate(n))))
      .toEqual(['pre_not_already_applied', 'post_schema_version_recorded']);
  });

  it('gates.yml: the standing invariant is self-armed, reads the handler\'s view, and floors the cultivar at the decided value', () => {
    const standing = bayGate('post_no_db_profile_leaves_the_potted_bay_unwarned');
    expect(standing).toContain(`WHERE EXISTS (SELECT 1 FROM public.schema_version WHERE version = '${BAY_STAMP}')`);
    expect(standing).toContain('JOIN public.v_resolved_care vrc ON vrc.leaf_id = p.id');
    const floors = [...standing.matchAll(/\('([0-9a-f-]{36})'::uuid, (\d+)\)/g)].map((m) => ({ cultivar: m[1], floor: Number(m[2]) }));
    expect(floors).toEqual([{ cultivar: BAY_CULTIVAR, floor: BAY_COLD.protect_below_F }]);
    expect(standing).toContain("vrc.resolved_profile->'cold'->'tender' = 'true'::jsonb");
    expect(standing).toContain(') IS NOT TRUE');
    expect(standing).toMatch(/expect: rowcount_eq\n {4}value: 0\n/);
  });

  it('gates.yml: the receipts and the premise carry the same row, planting, value and md5 as 0a', () => {
    const value = bayGate('post_the_row_carries_the_decided_value')
      .match(/\('([0-9a-f-]{36})'::uuid, '([0-9a-f-]{36})'::uuid, '(\{[^']*\})'::jsonb\)/);
    expect({ row: value[1], cultivar: value[2], cold: JSON.parse(value[3]) })
      .toEqual({ row: BAY_ROW, cultivar: BAY_CULTIVAR, cold: BAY_COLD });
    const view = bayGate('post_engine_view_of_the_planting_carries_the_cold_block')
      .match(/\('([0-9a-f-]{36})'::uuid, '(\{[^']*\})'::jsonb, '(\d+)'\)/);
    expect({ id: view[1], cold: JSON.parse(view[2]), wi: Number(view[3]) })
      .toEqual({ id: BAY_PLANTING, cold: BAY_COLD, wi: BAY.db_cadence.water_interval_days_container });
    for (const name of ['pre_profile_is_the_backfill_row_without_cold', 'post_cold_fix_was_single_key_not_a_full_replace']) {
      expect(bayGate(name), name).toContain(`('${BAY_ROW}'::uuid, '${BAY_CULTIVAR}'::uuid, '${BAY_MD5_BEFORE}')`);
    }
    expect(bayGate('post_cold_fix_was_single_key_not_a_full_replace')).toContain("md5((cp.profile - 'cold')::text) = v.md5_before");
    const premise = bayGate('pre_the_engine_adopts_a_profile_without_cold');
    expect(premise).toContain(`vrc.leaf_id IN ('${BAY_PLANTING}')`);
    expect(premise).toContain("vrc.cadence_scopes = ARRAY['cultivar']");
    expect(premise).toContain("NOT (vrc.resolved_profile ? 'cold')");
    // No gate names any id but these three.
    const ids = new Set([...BAY_GATES.matchAll(/'([0-9a-f]{8}-[0-9a-f-]{27})'/g)].map((m) => m[1]));
    expect([...ids].sort()).toEqual([BAY_ROW, BAY_CULTIVAR, BAY_PLANTING].sort());
  });
});

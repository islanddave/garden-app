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

import { describe, it, expect } from 'vitest';
import fc from './frostClass.js';
const { frostClassForSlug, summarize, isContainer, CLASS_BY_SLUG, UNCERTAIN_SLUGS } = fc;

// Fixtures mirror the shape the daily-plan handler query returns, plus crop_type_slug from the
// plant_varieties join. Slugs and counts below are the LIVE prod values read 2026-08-04.
const p = (id, name, slug, extra = {}) => ({ id, name, crop_type_slug: slug, container_type: 'pot', status: 'vegetative', ...extra });

describe('frostClassForSlug — the three §3-4 classes', () => {
  it('classifies every slug §3-4 names as tender', () => {
    for (const s of ['pepper', 'tomato', 'tomatillo', 'basil', 'melon', 'watermelon', 'cucumber', 'squash', 'bean', 'nasturtium']) {
      expect(frostClassForSlug(s)).toMatchObject({ class: 'tender', countedAs: 'tender', source: 'slug' });
    }
  });

  it('classifies every slug §3-4 names as hardy', () => {
    for (const s of ['kale', 'cabbage', 'broccoli', 'carrot', 'beet', 'leek']) {
      expect(frostClassForSlug(s)).toMatchObject({ class: 'hardy', countedAs: 'hardy', source: 'slug' });
    }
  });

  it('an unmapped slug is unknown and is COUNTED AS TENDER (§3-4 fail-safe)', () => {
    const r = frostClassForSlug('dragonfruit');
    expect(r.class).toBe('unknown');
    expect(r.countedAs).toBe('tender');
    expect(r.source).toBe('unmapped');
    expect(r.slug).toBe('dragonfruit');
  });

  it('a NULL / missing / blank slug is unknown, counted as tender, source=missing', () => {
    for (const v of [null, undefined, '', '   ', 42, {}]) {
      const r = frostClassForSlug(v);
      expect(r.class).toBe('unknown');
      expect(r.countedAs).toBe('tender');
      expect(r.source).toBe('missing');
    }
  });

  it('normalizes case and surrounding whitespace', () => {
    expect(frostClassForSlug('  PEPPER ').class).toBe('tender');
    expect(frostClassForSlug('Kale').class).toBe('hardy');
  });

  it('never returns a class outside {tender,hardy,unknown}', () => {
    for (const s of [...Object.keys(CLASS_BY_SLUG), 'nope', null]) {
      expect(['tender', 'hardy', 'unknown']).toContain(frostClassForSlug(s).class);
    }
  });
});

describe('cadence cold.tender is a PROMOTION-ONLY input', () => {
  it('promotes an otherwise-unknown slug to tender and records the source', () => {
    const r = frostClassForSlug('mystery_crop', { cadenceTender: true });
    expect(r).toMatchObject({ class: 'tender', countedAs: 'tender', source: 'cadence' });
  });

  it('does NOT promote a slug explicitly classified hardy — the by_variety["Peach"] collision', () => {
    // cadence-data-v2.json by_variety['Peach'] is a PEPPER profile (cold.tender, protect_below_F 50) and
    // collides with the live "Peach tree" planting whose variety name is also "Peach". Cadence-wins
    // precedence would mark a mature peach tree tender at 50°F.
    const r = frostClassForSlug('peach', { cadenceTender: true });
    expect(r.class).toBe('hardy');
    expect(r.source).toBe('slug');
  });

  it('leaves an unknown slug unknown when the cadence signal is absent', () => {
    expect(frostClassForSlug('mystery_crop', { cadenceTender: false }).class).toBe('unknown');
  });
});

describe('deliberately-unmapped slugs fall through to unknown, never to a guess', () => {
  it('each UNCERTAIN slug is genuinely absent from the map', () => {
    for (const s of UNCERTAIN_SLUGS) {
      expect(CLASS_BY_SLUG[s]).toBeUndefined();
      expect(frostClassForSlug(s)).toMatchObject({ class: 'unknown', countedAs: 'tender' });
    }
  });

  it('sedum specifically — the live rows are the TENDER S. adolphii, so a "hardy" guess would be wrong', () => {
    expect(frostClassForSlug('sedum').countedAs).toBe('tender');
  });
});

describe('summarize — exposure counts consumed by the alert copy', () => {
  const rows = [
    p('t1', 'Jalapeno', 'pepper', { status: 'fruiting' }),
    p('t2', 'Sungold', 'tomato', { status: 'fruiting' }),
    p('t3', 'Genovese', 'basil', { container_type: 'in_ground', status: 'vegetative' }),
    p('h1', 'Lacinato', 'kale', { container_type: 'in_ground' }),
    p('h2', 'Nantes', 'carrot', { container_type: 'in_ground' }),
    p('u1', 'Lantana', null, { status: 'flowering' }),
    p('u2', 'Neon Rose Calibrachoa', null),
    p('u3', 'Golden Sedum', 'sedum'),
  ];

  it('counts tender / hardy / unknown separately and rolls unknown into atRisk', () => {
    const s = summarize(rows);
    expect(s.tender).toBe(3);
    expect(s.hardy).toBe(2);
    expect(s.unknown).toBe(3);
    expect(s.atRisk).toBe(6);   // tender + unknown (§3-4 unknown-counted-as-tender)
  });

  it('unknown is REPORTED separately, with the offending slugs listed', () => {
    const s = summarize(rows);
    expect(s.unknownPlantings.map((x) => x.name).sort()).toEqual(['Golden Sedum', 'Lantana', 'Neon Rose Calibrachoa']);
    expect(s.unknownSlugs).toEqual(['sedum']);  // the two NULL-slug rows contribute no slug
  });

  it('counts at-risk containers (listed first per §3-4) and fruiting/flowering', () => {
    const s = summarize(rows);
    // pots: pepper, tomato, Lantana, Calibrachoa, sedum. basil + both hardy rows are in_ground.
    expect(s.tenderContainers).toBe(5);
    expect(s.tenderFruiting).toBe(3);    // pepper(fruiting), tomato(fruiting), Lantana(flowering)
  });

  it('orders containers first, then fruiting, then the rest', () => {
    const s = summarize(rows);
    expect(s.tenderPlantings[0].container).toBe(true);
    const lastIsInGround = s.tenderPlantings[s.tenderPlantings.length - 1];
    expect(lastIsInGround.name).toBe('Genovese');
  });

  it('hardy plantings never appear in any at-risk list', () => {
    const s = summarize(rows);
    const named = [...s.tenderPlantings, ...s.unknownPlantings].map((x) => x.name);
    expect(named).not.toContain('Lacinato');
    expect(named).not.toContain('Nantes');
  });

  it('empty / null / garbage input returns zeroed counts, not a crash', () => {
    for (const v of [[], null, undefined, 'nope']) {
      const s = summarize(v);
      expect(s).toMatchObject({ tender: 0, hardy: 0, unknown: 0, atRisk: 0 });
    }
  });

  it('skips null rows inside an otherwise-valid list', () => {
    const s = summarize([null, p('t1', 'Jalapeno', 'pepper'), undefined]);
    expect(s.tender).toBe(1);
  });

  it('accepts a cadenceTenderFor injector and applies it per planting', () => {
    const s = summarize([p('x1', 'Mystery', 'mystery_crop'), p('x2', 'Other Mystery', 'other_mystery')], {
      cadenceTenderFor: (row) => row.id === 'x1',
    });
    expect(s.tender).toBe(1);
    expect(s.unknown).toBe(1);
    expect(s.atRisk).toBe(2);   // both still alerted; only the LABEL differs
  });
});

describe('isContainer', () => {
  it('in_ground is not a container', () => {
    expect(isContainer({ container_type: 'in_ground' })).toBe(false);
  });
  it('any other non-empty container_type is a container', () => {
    for (const t of ['pot', 'fabric_bag', 'raised_bed', 'GROW_BAG']) expect(isContainer({ container_type: t })).toBe(true);
  });
  it('null/blank container_type is not treated as a container', () => {
    expect(isContainer({ container_type: null })).toBe(false);
    expect(isContainer({ container_type: '  ' })).toBe(false);
    expect(isContainer({})).toBe(false);
    expect(isContainer(null)).toBe(false);
  });
});

describe('live-prod slug coverage (read from Neon 2026-08-04, 250 live plantings / 80 distinct slugs)', () => {
  // The 20 largest live slug buckets, verbatim from prod, with the class each MUST resolve to.
  const LIVE = [
    ['pepper', 58, 'tender'], ['tomato', 44, 'tender'], ['basil', 7, 'tender'], ['geranium', 6, 'tender'],
    ['lettuce', 5, 'hardy'], ['broccoli', 4, 'hardy'], ['melon', 4, 'tender'], ['bean', 3, 'tender'],
    ['cabbage', 3, 'hardy'], ['carrot', 3, 'hardy'], ['coleus', 3, 'tender'], ['echeveria', 3, 'tender'],
    ['fittonia', 3, 'tender'], ['kale', 3, 'hardy'], ['nasturtium', 3, 'tender'], ['onion', 3, 'hardy'],
    ['oregano', 3, 'hardy'], ['potato', 3, 'tender'], ['tomatillo', 3, 'tender'], ['watermelon', 3, 'tender'],
  ];
  it.each(LIVE)('%s (%i live plantings) -> %s', (slug, _n, expected) => {
    expect(frostClassForSlug(slug).class).toBe(expected);
  });

  it('the tender bucket reproduces the §1 exposure framing (pepper+tomato dominate)', () => {
    const rows = LIVE.flatMap(([slug, n]) => Array.from({ length: n }, (_, i) => p(`${slug}${i}`, slug, slug)));
    const s = summarize(rows);
    // tender 58+44+7+6+4+3*8 = 143 ; hardy 5+4+3*5 = 24.
    expect(s.tender).toBe(143);
    expect(s.hardy).toBe(24);
    expect(s.unknown).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// D6 (Dave, 2026-08-04) — thresholds are PER CROP TYPE, and already-covered plantings are excluded.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
const {
  resolveBandThresholds, BAND_THRESHOLDS, BAND_BY_SLUG, SLUGS_BY_BAND, BAND_ORDER, UNKNOWN_BAND,
  cropLabel, isCoveredDefault, TENDER_SLUGS,
} = fc;

// The full plant_varieties.crop_type_slug domain, read from live prod Neon 2026-08-04 (120 values).
const LIVE_DOMAIN = ('althaea artichoke arugula asparagus avocado basil bay bean bee_balm beet begonia bitter_melon '
  + 'black_raspberry blackberry blackberry_lily blueberry bok_choy borage broccoli brussels_sprouts bunching_onion '
  + 'cabbage cactus carnation carrot celery chervil chives christmas_cactus chrysanthemum cilantro cobaea coleus '
  + 'collard columbine crown_of_thorns cucamelon cucumber culantro delphinium dill dracaena echeveria edelweiss '
  + 'eggplant endive fittonia flower_mix four_o_clock foxglove garlic geranium haworthia helichrysum hibiscus '
  + 'hollyhock hosta jade japanese_maple kale kohlrabi leek lemon_verbena lemongrass lettuce lithops luffa marigold '
  + 'melon milkweed mint money_plant morning_glory mustard nasturtium okra onion oregano parsley parsnip pea peach '
  + 'pepper perilla petunia pineapple poppy potato pothos radicchio radish rat_tail_radish red_raspberry rose '
  + 'rosemary sage sedum sempervivum shallot spider_plant spinach squash stock strawberry succulent sunflower '
  + 'sweet_potato tarragon thunbergia thyme tomatillo tomato torenia tradescantia tweedia vietnamese_coriander '
  + 'viola watermelon wineberry winter_squash').split(' ');

describe('D6 bands — the per-crop-type threshold table', () => {
  it('the tender band IS the D2-approved baseline (40 / 38 / 33)', () => {
    expect(BAND_THRESHOLDS.tender).toMatchObject({ ADVISORY_LOW_F: 40, IMMINENT_LOW_F: 38, HARD_FREEZE_LOW_F: 33 });
  });

  it('hardy carries NO trip points — it can never be alerted (§3-4)', () => {
    expect(BAND_THRESHOLDS.hardy).toBeNull();
    expect(frostClassForSlug('kale').thresholds).toBeNull();
  });

  it('bands are strictly ordered by cold tolerance — tropical trips first, light-frost-tolerant last', () => {
    const order = ['tropical', 'chill_sensitive', 'tender', 'light_frost_tolerant'];
    for (let i = 1; i < order.length; i++) {
      for (const k of ['ADVISORY_LOW_F', 'IMMINENT_LOW_F', 'HARD_FREEZE_LOW_F']) {
        expect(BAND_THRESHOLDS[order[i - 1]][k]).toBeGreaterThan(BAND_THRESHOLDS[order[i]][k]);
      }
    }
  });

  it('within every band, advisory >= imminent > hard freeze', () => {
    for (const b of BAND_ORDER) {
      const t = BAND_THRESHOLDS[b];
      if (!t) continue;
      expect(t.ADVISORY_LOW_F).toBeGreaterThanOrEqual(t.IMMINENT_LOW_F);
      expect(t.IMMINENT_LOW_F).toBeGreaterThan(t.HARD_FREEZE_LOW_F);
    }
  });

  it('a crop genuinely more cold-sensitive than a pepper gets a HIGHER trip point (the point of D6)', () => {
    expect(frostClassForSlug('basil').thresholds.IMMINENT_LOW_F)
      .toBeGreaterThan(frostClassForSlug('pepper').thresholds.IMMINENT_LOW_F);
    expect(frostClassForSlug('pothos').thresholds.IMMINENT_LOW_F)
      .toBeGreaterThan(frostClassForSlug('basil').thresholds.IMMINENT_LOW_F);
    expect(frostClassForSlug('marigold').thresholds.IMMINENT_LOW_F)
      .toBeLessThan(frostClassForSlug('pepper').thresholds.IMMINENT_LOW_F);
  });

  it('every band name in SLUGS_BY_BAND is a real band, and no slug is in two bands', () => {
    const seen = new Map();
    for (const b of Object.keys(SLUGS_BY_BAND)) {
      expect(BAND_ORDER).toContain(b);
      for (const s of SLUGS_BY_BAND[b]) {
        expect(seen.has(s), `${s} appears in both ${seen.get(s)} and ${b}`).toBe(false);
        seen.set(s, b);
      }
    }
  });

  it('every pre-D6 tender slug landed in an alerting band, never in hardy', () => {
    for (const s of TENDER_SLUGS) expect(BAND_BY_SLUG[s]).not.toBe('hardy');
  });

  it('the map still covers the WHOLE live crop_type_slug domain except the deliberate 8', () => {
    const gaps = LIVE_DOMAIN.filter((s) => !BAND_BY_SLUG[s] && !UNCERTAIN_SLUGS.includes(s));
    expect(gaps).toEqual([]);
  });

  it('pineapple — the one slug the pre-D6 map missed — is now classified tropical', () => {
    expect(frostClassForSlug('pineapple')).toMatchObject({ class: 'tender', band: 'tropical' });
  });

  it('an unknown slug is counted in the TENDER band (§3-4 fail-safe) while its class stays honest', () => {
    const r = frostClassForSlug('dragonfruit');
    expect(r.class).toBe('unknown');
    expect(r.band).toBe(UNKNOWN_BAND);
    expect(r.thresholds).toEqual(BAND_THRESHOLDS.tender);
  });
});

describe('D6 band threshold injection', () => {
  it('a per-call band override moves only that band', () => {
    const t = resolveBandThresholds({ tender: { IMMINENT_LOW_F: 36 } });
    expect(t.tender.IMMINENT_LOW_F).toBe(36);
    expect(t.tender.ADVISORY_LOW_F).toBe(BAND_THRESHOLDS.tender.ADVISORY_LOW_F);
    expect(t.chill_sensitive).toEqual(BAND_THRESHOLDS.chill_sensitive);
  });

  it('rejects an unknown band rather than silently ignoring it', () => {
    expect(() => resolveBandThresholds({ semi_hardy: { IMMINENT_LOW_F: 30 } })).toThrow(/unknown band/);
  });

  it('rejects an unknown trip-point key and a non-numeric value', () => {
    expect(() => resolveBandThresholds({ tender: { IMMINENT: 30 } })).toThrow(/unknown threshold/);
    expect(() => resolveBandThresholds({ tender: { IMMINENT_LOW_F: 'cold' } })).toThrow(/non-numeric/);
  });

  it('an overridden band reaches the classification, not just the table', () => {
    const bands = resolveBandThresholds({ tender: { IMMINENT_LOW_F: 45 } });
    expect(frostClassForSlug('pepper', { resolvedBands: bands }).thresholds.IMMINENT_LOW_F).toBe(45);
  });

  it('FROST_THRESHOLD_OFFSET_F shifts every band uniformly (the F5 rehearsal lever)', () => {
    const prev = process.env.FROST_THRESHOLD_OFFSET_F;
    process.env.FROST_THRESHOLD_OFFSET_F = '20';
    try {
      const t = resolveBandThresholds();
      expect(t.tender.IMMINENT_LOW_F).toBe(BAND_THRESHOLDS.tender.IMMINENT_LOW_F + 20);
      expect(t.tropical.HARD_FREEZE_LOW_F).toBe(BAND_THRESHOLDS.tropical.HARD_FREEZE_LOW_F + 20);
      expect(t.hardy).toBeNull();   // hardy has no trip point to shift
    } finally {
      if (prev === undefined) delete process.env.FROST_THRESHOLD_OFFSET_F; else process.env.FROST_THRESHOLD_OFFSET_F = prev;
    }
  });
});

describe('D6 covered-exclusion — an indoor planting is not named on a frost night', () => {
  const rows = [
    p('c1', 'Shelf Pepper', 'pepper', { covered: true }),
    p('c2', 'House Fittonia', 'fittonia', { covered: true }),
    p('c3', 'Stable Mystery', null, { covered: true }),
    p('o1', 'Deck Pepper', 'pepper'),
    p('o2', 'Bed Kale', 'kale', { container_type: 'in_ground' }),
    p('o3', 'Covered Kale', 'kale', { container_type: 'in_ground', covered: true }),
  ];

  it('covered at-risk plantings are excluded from every at-risk count', () => {
    const s = summarize(rows);
    expect(s.tender).toBe(1);
    expect(s.unknown).toBe(0);
    expect(s.atRisk).toBe(1);
    expect(s.tenderContainers).toBe(1);
  });

  it('the exclusion is REPORTED, never silent', () => {
    const s = summarize(rows);
    expect(s.coveredExcluded).toBe(3);
    expect(s.coveredExcludedSlugs).toEqual(['fittonia', 'pepper']);   // the NULL-slug row contributes none
  });

  it('a covered HARDY planting is counted hardy, not counted as an exclusion', () => {
    const s = summarize(rows);
    expect(s.hardy).toBe(2);                 // both kales, covered or not
    expect(s.coveredExcludedSlugs).not.toContain('kale');
  });

  it('covered plantings never appear in the named crop list', () => {
    const s = summarize(rows);
    expect(s.byCropType.map((c) => c.label)).toEqual(['peppers']);
    expect(s.byCropType[0].count).toBe(1);
  });

  it('excludeCovered:false opts out (the pre-D6 behaviour, kept reachable)', () => {
    const s = summarize(rows, { excludeCovered: false });
    expect(s.atRisk).toBe(4);
    expect(s.coveredExcluded).toBe(0);
  });

  it('a custom isCovered predicate wins over the default covered column', () => {
    const s = summarize(rows, { isCovered: (x) => x.name === 'Deck Pepper' });
    // The three `covered` rows now count; Deck Pepper does not. Both kales are hardy either way.
    expect(s.atRisk).toBe(3);
    expect(s.coveredExcluded).toBe(1);
  });

  it('isCoveredDefault reads exactly the handler query flag, and only when strictly true', () => {
    expect(isCoveredDefault({ covered: true })).toBe(true);
    for (const v of [false, null, undefined, 'true', 1]) expect(isCoveredDefault({ covered: v })).toBe(false);
    expect(isCoveredDefault(null)).toBe(false);
  });
});

describe('D6 byCropType — the coalesced alert names crop TYPES, not plantings', () => {
  const rows = [
    ...Array.from({ length: 4 }, (_, i) => p(`pe${i}`, `Pepper ${i}`, 'pepper', { status: 'fruiting' })),
    ...Array.from({ length: 2 }, (_, i) => p(`to${i}`, `Tomato ${i}`, 'tomato')),
    p('ba0', 'Basil', 'basil', { container_type: 'in_ground' }),
    p('ka0', 'Kale', 'kale', { container_type: 'in_ground' }),
    p('un0', 'Lantana', null),
    p('un1', 'Sedum', 'sedum'),
  ];

  it('groups at-risk plantings by crop type with per-type counts', () => {
    const s = summarize(rows);
    const byLabel = Object.fromEntries(s.byCropType.map((c) => [c.label, c]));
    expect(byLabel.peppers.count).toBe(4);
    expect(byLabel.peppers.containers).toBe(4);
    expect(byLabel.peppers.fruiting).toBe(4);
    expect(byLabel.tomatoes.count).toBe(2);
    expect(byLabel.basil.count).toBe(1);
    expect(byLabel.basil.containers).toBe(0);
  });

  it('every crop type carries ITS OWN trip points — that is the whole of D6', () => {
    const s = summarize(rows);
    const byLabel = Object.fromEntries(s.byCropType.map((c) => [c.label, c]));
    expect(byLabel.peppers.thresholds).toEqual(BAND_THRESHOLDS.tender);
    expect(byLabel.basil.thresholds).toEqual(BAND_THRESHOLDS.chill_sensitive);
    expect(byLabel.basil.thresholds.IMMINENT_LOW_F).toBeGreaterThan(byLabel.peppers.thresholds.IMMINENT_LOW_F);
  });

  it('hardy crop types never enter the list', () => {
    expect(summarize(rows).byCropType.map((c) => c.label)).not.toContain('kale');
  });

  it('all unknowns collapse into ONE synthetic bucket with a null slug (§3-4 states them separately)', () => {
    const s = summarize(rows);
    const unk = s.byCropType.filter((c) => c.slug === null);
    expect(unk).toHaveLength(1);
    expect(unk[0]).toMatchObject({ label: 'unclassified', class: 'unknown', count: 2 });
    expect(unk[0].thresholds).toEqual(BAND_THRESHOLDS.tender);
  });

  it('ordering is deterministic: most containers, then most plantings, then alphabetical', () => {
    const s = summarize(rows);
    expect(s.byCropType[0].label).toBe('peppers');
    const again = summarize(rows);
    expect(again.byCropType.map((c) => c.label)).toEqual(s.byCropType.map((c) => c.label));
  });

  it('a garden with nothing at risk yields an EMPTY crop list, not a missing one', () => {
    const s = summarize([p('k', 'Kale', 'kale')]);
    expect(s.byCropType).toEqual([]);
    expect(s.atRisk).toBe(0);
  });
});

describe('cropLabel — the alert has to read like English', () => {
  it.each([
    ['pepper', 'peppers'], ['tomato', 'tomatoes'], ['tomatillo', 'tomatillos'], ['potato', 'potatoes'],
    ['sweet_potato', 'sweet potatoes'], ['squash', 'squash'], ['basil', 'basil'], ['okra', 'okra'],
    ['nasturtium', 'nasturtiums'], ['morning_glory', 'morning glories'], ['bean', 'beans'],
    ['four_o_clock', "four o'clocks"], ['spider_plant', 'spider plants'], ['pothos', 'pothos'],
  ])('%s -> %s', (slug, label) => expect(cropLabel(slug)).toBe(label));

  it('a null slug reads as unclassified, never as "nulls"', () => {
    expect(cropLabel(null)).toBe('unclassified');
  });

  it('an unmapped slug still gets a readable plural rather than a raw slug', () => {
    expect(cropLabel('dragon_fruit')).toBe('dragon fruits');
  });
});

describe('D6 live-prod gate — the numbers Dave will actually receive (Neon 2026-08-04, 250 live plantings)', () => {
  // Slug|covered|container counts straight from prod. Reconstructing plantings from them makes this a real
  // count check (the design's stated F2 gate), not a restatement of the module's own arithmetic.
  const LIVE = [
    ['pepper', 58, 0, 56], ['tomato', 44, 0, 39], ['basil', 7, 0, 7], ['geranium', 6, 1, 6],
    ['lettuce', 5, 5, 5], ['broccoli', 4, 2, 4], ['melon', 4, 0, 0], [null, 3, 0, 3],
    ['bean', 3, 0, 0], ['cabbage', 3, 2, 3], ['carrot', 3, 0, 3], ['coleus', 3, 0, 2],
    ['echeveria', 3, 3, 2], ['fittonia', 3, 3, 3], ['kale', 3, 3, 3], ['nasturtium', 3, 0, 2],
    ['onion', 3, 0, 3], ['oregano', 3, 0, 0], ['potato', 3, 0, 3], ['succulent', 3, 3, 2],
    ['tarragon', 3, 0, 2], ['tomatillo', 3, 0, 3], ['watermelon', 3, 0, 0],
  ];
  const rows = LIVE.flatMap(([slug, n, covered, containers]) => Array.from({ length: n }, (_, i) => ({
    id: `${slug}-${i}`, name: `${slug} ${i}`, crop_type_slug: slug,
    container_type: i < containers ? 'pot' : 'in_ground',
    covered: i < covered, status: 'vegetative',
  })));

  it('covered plantings are excluded — 19 of them across the live garden', () => {
    const s = summarize(rows);
    // covered AND at-risk: geranium 1, echeveria 3, fittonia 3, succulent 3 = 10 in this top-23 slice
    // (lettuce/broccoli/cabbage/kale are hardy and never counted as exclusions).
    expect(s.coveredExcluded).toBe(10);
    expect(summarize(rows, { excludeCovered: false }).atRisk).toBe(s.atRisk + s.coveredExcluded);
  });

  it('the four largest at-risk crop types are peppers, tomatoes, basil, geraniums — in that order', () => {
    const s = summarize(rows);
    expect(s.byCropType.slice(0, 4).map((c) => c.label)).toEqual(['peppers', 'tomatoes', 'basil', 'geraniums']);
    expect(s.byCropType[0].count).toBe(58);
  });

  it('the crop list is an order of magnitude shorter than the planting list — why D6 coalescing works', () => {
    const s = summarize(rows);
    expect(s.byCropType.length).toBeLessThan(s.atRisk / 5);
  });
});

import { describe, it, expect } from 'vitest';
import { computeDerivedTags, humanizeLifecycle, VALID_LIFECYCLE, heatBand, parseDeterminacy, parseDayLength, alliumType, basilUse, beanType, beanHabit, beanUse } from './crop-derive.js';

const CROP_TYPES = {
  pepper: { slug: 'pepper', display_name: 'Pepper', default_lifecycle: 'tender_perennial' },
  basil: { slug: 'basil', display_name: 'Basil', default_lifecycle: 'annual' },
  beet: { slug: 'beet', display_name: 'Beet', default_lifecycle: 'biennial' },
  tomato: { slug: 'tomato', display_name: 'Tomato', default_lifecycle: 'tender_perennial' },
  onion: { slug: 'onion', display_name: 'Onion', default_lifecycle: 'biennial' },
  garlic: { slug: 'garlic', display_name: 'Garlic', default_lifecycle: 'perennial' },
  chives: { slug: 'chives', display_name: 'Chives', default_lifecycle: 'perennial' },
  leek: { slug: 'leek', display_name: 'Leek', default_lifecycle: 'biennial' },
};

describe('humanizeLifecycle', () => {
  it('title-cases underscored values', () => {
    expect(humanizeLifecycle('tender_perennial')).toBe('Tender Perennial');
    expect(humanizeLifecycle('annual')).toBe('Annual');
  });
});

describe('computeDerivedTags', () => {
  it('typed cultivar -> type: + lifecycle: (lifecycle wins over crop default)', () => {
    const out = computeDerivedTags({ crop_type_slug: 'pepper', lifecycle: 'annual' }, CROP_TYPES);
    expect(out).toEqual([
      { facet: 'type', slug: 'pepper', label: 'Pepper' },
      { facet: 'lifecycle', slug: 'annual', label: 'Annual' },
    ]);
  });
  it('falls back to crop_types.default_lifecycle when cultivar.lifecycle is null', () => {
    const out = computeDerivedTags({ crop_type_slug: 'pepper', lifecycle: null }, CROP_TYPES);
    expect(out).toContainEqual({ facet: 'lifecycle', slug: 'tender_perennial', label: 'Tender Perennial' });
    expect(out).toContainEqual({ facet: 'type', slug: 'pepper', label: 'Pepper' });
  });
  it('untyped cultivar (no crop_type_slug, no lifecycle) -> empty desired set', () => {
    expect(computeDerivedTags({ crop_type_slug: null, lifecycle: null }, CROP_TYPES)).toEqual([]);
  });
  it('drifted crop_type_slug (absent from map) -> no type tag, no throw', () => {
    const out = computeDerivedTags({ crop_type_slug: 'ghost_crop', lifecycle: 'annual' }, CROP_TYPES);
    expect(out).toEqual([{ facet: 'lifecycle', slug: 'annual', label: 'Annual' }]);
  });
  it('off-vocabulary lifecycle is dropped (whitelist)', () => {
    const out = computeDerivedTags({ crop_type_slug: 'basil', lifecycle: 'weird-value' }, CROP_TYPES);
    expect(out).toEqual([{ facet: 'type', slug: 'basil', label: 'Basil' }]);
  });
  it('lifecycle-only (no crop type) still derives a lifecycle tag', () => {
    expect(computeDerivedTags({ crop_type_slug: null, lifecycle: 'perennial' }, CROP_TYPES))
      .toEqual([{ facet: 'lifecycle', slug: 'perennial', label: 'Perennial' }]);
  });
  it('null cultivar -> empty', () => {
    expect(computeDerivedTags(null, CROP_TYPES)).toEqual([]);
  });
  it('VALID_LIFECYCLE is the 4-value vocabulary', () => {
    expect(VALID_LIFECYCLE).toEqual(['annual', 'perennial', 'biennial', 'tender_perennial']);
  });
});

// ── V4-CLASSIFY-001 classification facets ───────────────────────────────────────────────────────
describe('heatBand (pepper heat by scoville_max ceiling)', () => {
  it('bands by the MAX ceiling; boundaries fall in real-collection gaps', () => {
    expect(heatBand(0).slug).toBe('sweet');
    expect(heatBand(100).slug).toBe('mild');
    expect(heatBand(999).slug).toBe('mild');
    expect(heatBand(1000).slug).toBe('medium');
    expect(heatBand(8000).slug).toBe('medium');   // Santa Fe Grande / Jalapeno ceiling = Medium, not Hot
    expect(heatBand(9999).slug).toBe('medium');
    expect(heatBand(10000).slug).toBe('hot');
    expect(heatBand(49999).slug).toBe('hot');
    expect(heatBand(50000).slug).toBe('very_hot');
    expect(heatBand(249999).slug).toBe('very_hot');
    expect(heatBand(250000).slug).toBe('superhot');
    expect(heatBand(1300000).slug).toBe('superhot');
  });
  it('null / invalid -> null (no fabricated band)', () => {
    expect(heatBand(null)).toBeNull();
    expect(heatBand(undefined)).toBeNull();
    expect(heatBand(-5)).toBeNull();
    expect(heatBand('nope')).toBeNull();
  });
});

describe('parseDeterminacy (substring-safe, leftmost-primary)', () => {
  it('classifies the four determinacy values', () => {
    expect(parseDeterminacy('indeterminate vine; 5-7 ft; stake or cage required')).toBe('indeterminate');
    expect(parseDeterminacy('determinate bush slicer; compact; minimal staking')).toBe('determinate');
    expect(parseDeterminacy('semi-determinate bush, 4-5 ft')).toBe('semi_determinate');
    expect(parseDeterminacy('determinate dwarf bush; 30-36 in')).toBe('dwarf'); // dwarf refines determinate
  });
  it('leftmost-primary: "indeterminate (semi-determinate per some sources)" -> indeterminate, NOT semi', () => {
    expect(parseDeterminacy('indeterminate vine (semi-determinate per some sources); 5-6 ft')).toBe('indeterminate');
  });
  it('dwarf never overrides an indeterminate/semi primary', () => {
    expect(parseDeterminacy('indeterminate dwarf-leaved oddity')).toBe('indeterminate');
  });
  it('null / unparseable -> null (no fabrication)', () => {
    expect(parseDeterminacy(null)).toBeNull();
    expect(parseDeterminacy('mid-sized productive plant')).toBeNull();
  });
});

describe('parseDayLength (onion, from prose)', () => {
  it('reads long/short/neutral when stated', () => {
    expect(parseDayLength('bulb forms when day length exceeds 14 hrs (long-day type)')).toBe('long_day');
    expect(parseDayLength('short-day southern onion')).toBe('short_day');
    expect(parseDayLength('day-neutral / intermediate')).toBe('day_neutral');
  });
  it('null when not stated', () => {
    expect(parseDayLength('upright non-bulbing bunching clump')).toBeNull();
    expect(parseDayLength(null)).toBeNull();
  });
});

describe('alliumType (bulbing vs bunching)', () => {
  it('garlic/shallot -> bulbing; chives -> bunching', () => {
    expect(alliumType('garlic', null)).toBe('bulbing');
    expect(alliumType('shallot', null)).toBe('bulbing');
    expect(alliumType('chives', null)).toBe('bunching');
  });
  it('onion resolves from prose; leek -> null', () => {
    expect(alliumType('onion', 'single bulb forms at soil level (long-day)')).toBe('bulbing');
    expect(alliumType('onion', 'upright non-bulbing clump; bunching habit')).toBe('bunching');
    expect(alliumType('leek', 'upright non-bulbing blanched stem')).toBeNull();
    expect(alliumType('onion', 'ambiguous')).toBeNull();
  });
});

describe('basilUse (from species; evidence-based, no default without species)', () => {
  it('maps species to culinary/thai/tulsi', () => {
    expect(basilUse('basil', 'basilicum')).toBe('culinary');
    expect(basilUse('basil', 'basilicum var. thyrsiflora')).toBe('thai');
    expect(basilUse('basil', 'tenuiflorum')).toBe('tulsi');
    expect(basilUse('basil', 'sanctum')).toBe('tulsi');
  });
  it('no species -> null (does not assume culinary); non-basil -> null', () => {
    expect(basilUse('basil', null)).toBeNull();
    expect(basilUse('basil', '')).toBeNull();
    expect(basilUse('tomato', 'lycopersicum')).toBeNull();
  });
});

describe('computeDerivedTags with classification facets', () => {
  it('pepper emits a heat tag from scoville_max', () => {
    const out = computeDerivedTags({ crop_type_slug: 'pepper', lifecycle: 'annual', scoville_max: 8000 }, CROP_TYPES);
    expect(out).toContainEqual({ facet: 'heat', slug: 'medium', label: 'Medium' });
  });
  it('tomato prefers determinacy column, falls back to prose (closes L-239 for unfaceted intake)', () => {
    const col = computeDerivedTags({ crop_type_slug: 'tomato', determinacy: 'determinate', growth_habit: 'indeterminate vine' }, CROP_TYPES);
    expect(col).toContainEqual({ facet: 'determinacy', slug: 'determinate', label: 'Determinate' }); // column wins
    const prose = computeDerivedTags({ crop_type_slug: 'tomato', determinacy: null, growth_habit: 'indeterminate vine' }, CROP_TYPES);
    expect(prose).toContainEqual({ facet: 'determinacy', slug: 'indeterminate', label: 'Indeterminate' }); // prose fallback
  });
  it('onion emits day_length + allium_type; basil emits basil_use', () => {
    const onion = computeDerivedTags({ crop_type_slug: 'onion', day_length_response: 'long_day', growth_habit: 'single bulb forms' }, CROP_TYPES);
    expect(onion).toContainEqual({ facet: 'day_length', slug: 'long_day', label: 'Long-Day' });
    expect(onion).toContainEqual({ facet: 'allium_type', slug: 'bulbing', label: 'Bulbing' });
    const basil = computeDerivedTags({ crop_type_slug: 'basil', species: 'basilicum var. thyrsiflora' }, CROP_TYPES);
    expect(basil).toContainEqual({ facet: 'basil_use', slug: 'thai', label: 'Thai' });
  });
  it('a bare typed cultivar (no scoville/prose/species) emits ONLY type+lifecycle (no spurious facets)', () => {
    const out = computeDerivedTags({ crop_type_slug: 'pepper', lifecycle: 'annual' }, CROP_TYPES);
    expect(out).toEqual([
      { facet: 'type', slug: 'pepper', label: 'Pepper' },
      { facet: 'lifecycle', slug: 'annual', label: 'Annual' },
    ]);
  });
});

// ── V4-BEANFACET-001 bean facets ──────────────────────────────────────────────────────────
describe('beanType (species group; structured genus/species first, name/prose fallback)', () => {
  it('maps binomial + bare epithet (bean-gated so epithet alone is safe)', () => {
    expect(beanType('bean', 'Phaseolus', 'vulgaris')).toBe('common');
    expect(beanType('bean', 'Phaseolus', 'coccineus')).toBe('runner');
    expect(beanType('bean', '', 'lunatus')).toBe('lima');
    expect(beanType('bean', 'Vicia', 'faba')).toBe('fava');
    expect(beanType('bean', 'Glycine', 'max')).toBe('soybean');
  });
  it('Vigna unguiculata disambiguates yardlong vs cowpea by name', () => {
    expect(beanType('bean', 'Vigna', 'unguiculata', 'Red Noodle Yardlong')).toBe('yardlong');
    expect(beanType('bean', 'Vigna', 'unguiculata', 'California Blackeye')).toBe('cowpea');
    expect(beanType('bean', 'Vigna', 'unguiculata')).toBe('cowpea'); // bare -> cowpea (type species)
  });
  it('name/prose fallback only when species is absent + unambiguous', () => {
    expect(beanType('bean', null, null, 'Windsor Broad Bean')).toBe('fava');
    expect(beanType('bean', null, null, 'Big Mama', 'productive pole bean')).toBeNull(); // no species signal
  });
  it('never defaults to common on absent species; non-bean -> null', () => {
    expect(beanType('bean', null, null, 'Mystery Bean')).toBeNull();
    expect(beanType('tomato', 'Solanum', 'lycopersicum', 'Big Boy')).toBeNull();
  });
});

describe('beanHabit (bush | half_runner | pole; runner-name collision guard)', () => {
  it('reads explicit habit from name or prose', () => {
    expect(beanHabit('bean', 'Provider', 'bush, 50 days, green snap')).toBe('bush');
    expect(beanHabit('bean', 'Kentucky Wonder', 'pole, climbing 6-8 ft')).toBe('pole');
    expect(beanHabit('bean', 'Blue Lake Bush', null)).toBe('bush');           // name signal
    expect(beanHabit('bean', 'Mountain Half-Runner', null)).toBe('half_runner');
  });
  it('KEYSTONE: name-word "runner" is species, NOT habit — only prose runner / climb sets pole', () => {
    expect(beanHabit('bean', 'Scarlet Runner', null)).toBeNull();             // name-only runner -> no habit
    expect(beanHabit('bean', 'Scarlet Runner', 'vigorous climber, 8-10 ft')).toBe('pole'); // prose climb
    expect(beanHabit('bean', 'Painted Lady', 'runner-type climbing habit')).toBe('pole');  // prose runner
  });
  it('bush "self-supporting/no support" wins over any later cue; null when silent', () => {
    expect(beanHabit('bean', 'Windsor', 'erect 3-4 ft, self-supporting')).toBe('bush');
    expect(beanHabit('bean', 'Generic Bean', 'productive and tasty')).toBeNull();
  });
});

describe('beanUse (snap | shell | dry | dual_purpose; two families -> dual)', () => {
  it('single family -> that use', () => {
    expect(beanUse('bean', 'common', 'Provider', 'green snap bean')).toBe('snap');
    expect(beanUse('bean', 'fava', 'Windsor', 'broad shelling bean')).toBe('shell');
    expect(beanUse('bean', 'common', 'Black Turtle', 'dry soup bean')).toBe('dry');
  });
  it('two distinct families stated -> dual_purpose', () => {
    expect(beanUse('bean', 'common', 'Vermont Cranberry', 'bush horticultural bean, shell or dry')).toBe('dual_purpose');
    expect(beanUse('bean', 'runner', 'Scarlet Runner', 'young pods or dried beans')).toBe('dual_purpose');
  });
  it('type-priors apply only when text is silent; never override stated use', () => {
    expect(beanUse('bean', 'soybean', 'Midori Giant', null)).toBe('shell');   // edamame prior
    expect(beanUse('bean', 'lima', 'Fordhook', null)).toBe('shell');
    expect(beanUse('bean', 'cowpea', 'Pinkeye Purple Hull', null)).toBe('dry');
    expect(beanUse('bean', 'common', 'Silent Bean', null)).toBeNull();        // no signal, no prior
  });
});

describe('computeDerivedTags — bean end-to-end', () => {
  const BEANS = { bean: { slug: 'bean', display_name: 'Bean', default_lifecycle: 'annual' } };
  it('Provider bush snap common bean -> type+lifecycle+3 bean facets', () => {
    const out = computeDerivedTags({ crop_type_slug: 'bean', genus: 'Phaseolus', species: 'vulgaris', name: 'Provider', growth_habit: 'bush, 50 days, reliable green snap bean' }, BEANS);
    expect(out).toContainEqual({ facet: 'type', slug: 'bean', label: 'Bean' });
    expect(out).toContainEqual({ facet: 'bean_type', slug: 'common', label: 'Common bean' });
    expect(out).toContainEqual({ facet: 'bean_habit', slug: 'bush', label: 'Bush' });
    expect(out).toContainEqual({ facet: 'bean_use', slug: 'snap', label: 'Snap / green' });
  });
  it('Scarlet Runner: habit from prose (not name), dual use', () => {
    const out = computeDerivedTags({ crop_type_slug: 'bean', genus: 'Phaseolus', species: 'coccineus', name: 'Scarlet Runner', growth_habit: 'vigorous climber, 8-10 ft; young pods or dried beans' }, BEANS);
    expect(out).toContainEqual({ facet: 'bean_type', slug: 'runner', label: 'Runner bean' });
    expect(out).toContainEqual({ facet: 'bean_habit', slug: 'pole', label: 'Pole' });
    expect(out).toContainEqual({ facet: 'bean_use', slug: 'dual_purpose', label: 'Dual-purpose' });
  });
  it('a bare bean (crop only, no attributes) emits ONLY type+lifecycle', () => {
    const out = computeDerivedTags({ crop_type_slug: 'bean' }, BEANS);
    expect(out).toEqual([
      { facet: 'type', slug: 'bean', label: 'Bean' },
      { facet: 'lifecycle', slug: 'annual', label: 'Annual' },
    ]);
  });
});

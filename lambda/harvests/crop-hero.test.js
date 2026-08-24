// V4-HARVCROPPHOTO-001 — the crop hero: which planting represents a crop, and which photo it maps to.
//
// WHY THIS FILE EXISTS. The feature reads as "put a thumbnail next to each crop", and the part that
// can silently ship wrong is neither the thumbnail nor the SQL — it is the two joins in the middle:
//   (1) WHICH planting wins. first_pick[] tracks the MINIMUM day_key and there was no maximum
//       anywhere in the payload, so this is a new selection, not a re-read of an existing one. A
//       wrong winner renders a plausible photo of the wrong plant and nothing anywhere says so.
//   (2) WHETHER the photo lands on the crop. applyCropHeroPhotos keys the second query's rowset
//       against hero_plant_id; a key mismatch yields a payload where every hero_photo_id is null,
//       which is indistinguishable from "no crop has a photo" — the same silent-merge class
//       applyWeights carries its own test file for.
// Both are pure functions here precisely so they can be CALLED. lambda/harvests/index.js imports
// neon/clerk/aws at module load and cannot be imported under the root vitest run, so anything that
// lived there could only ever be guarded by a regex over its own source text, and no regex checks a
// Map key.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeAggregates, applyCropHeroPhotos } from './aggregate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

// One aggregates-query row. Only the fields the hero selection reads are interesting; the rest are
// present because computeAggregates would otherwise bucket the row somewhere unexpected.
function row({ event_id, day_key, plant_id, crop = 'tomato', gn_id = plant_id }) {
  return {
    event_id, day_key, plant_id, gn_id,
    project_id: 'proj-1', project_name: 'Garden',
    planting_name: `planting ${plant_id}`, variety_id: 'var-1', variety_name: 'Moskvich',
    crop_slug: crop, crop_name: crop === 'tomato' ? 'Tomato' : crop,
    harvest_log_id: `h-${event_id}`, quantity: 1, unit: 'count',
  };
}

const cropOf = (agg, slug) => agg.crops.find((c) => c.crop_type_slug === slug);

describe('hero selection — the most recently harvested planting of each crop', () => {
  it('picks the LATEST day_key, not the earliest (first_pick tracks the opposite end)', () => {
    const agg = computeAggregates([
      row({ event_id: 'e1', day_key: '2026-06-01', plant_id: 'pl-early' }),
      row({ event_id: 'e2', day_key: '2026-08-20', plant_id: 'pl-late' }),
      row({ event_id: 'e3', day_key: '2026-07-04', plant_id: 'pl-mid' }),
    ]);
    expect(cropOf(agg, 'tomato').hero_plant_id).toBe('pl-late');
    // The opposite end still reads the opposite way — this must not have moved first_pick.
    expect(agg.first_pick.find((f) => f.plant_id === 'pl-early').first_pick_date).toBe('2026-06-01');
  });

  it('is order-independent: the same rowset shuffled picks the same planting', () => {
    const rows = [
      row({ event_id: 'e1', day_key: '2026-06-01', plant_id: 'pl-a' }),
      row({ event_id: 'e2', day_key: '2026-08-20', plant_id: 'pl-b' }),
      row({ event_id: 'e3', day_key: '2026-07-04', plant_id: 'pl-c' }),
    ];
    const forward = cropOf(computeAggregates(rows), 'tomato').hero_plant_id;
    const reversed = cropOf(computeAggregates([...rows].reverse()), 'tomato').hero_plant_id;
    expect(forward).toBe('pl-b');
    expect(reversed).toBe('pl-b');
  });

  // day_key is DATE-grain (482 of 504 live rows sit at exactly 08:00 ET), so a same-day tie is the
  // common case, not an edge one. Without the second key the winner would follow Postgres row order
  // and two identical requests could disagree.
  it('breaks a same-day tie on event_id DESC, deterministically both ways round', () => {
    const rows = [
      row({ event_id: 'aaa', day_key: '2026-08-20', plant_id: 'pl-a' }),
      row({ event_id: 'zzz', day_key: '2026-08-20', plant_id: 'pl-z' }),
    ];
    expect(cropOf(computeAggregates(rows), 'tomato').hero_plant_id).toBe('pl-z');
    expect(cropOf(computeAggregates([...rows].reverse()), 'tomato').hero_plant_id).toBe('pl-z');
  });

  it('scopes the hero per crop — one crop’s later pick never wins another crop’s row', () => {
    const agg = computeAggregates([
      row({ event_id: 'e1', day_key: '2026-08-20', plant_id: 'pl-tom', crop: 'tomato' }),
      row({ event_id: 'e2', day_key: '2026-08-22', plant_id: 'pl-bean', crop: 'bean' }),
    ]);
    expect(cropOf(agg, 'tomato').hero_plant_id).toBe('pl-tom');
    expect(cropOf(agg, 'bean').hero_plant_id).toBe('pl-bean');
  });

  // A soft-deleted planting LEFT-JOINs to a NULL gn_id while the harvest row itself survives (the
  // read model requires that — quantities must never vanish). Naming it as the hero would resolve a
  // photo off a row the page cannot show.
  it('ignores a row whose planting is soft-deleted, even when it is the most recent', () => {
    const agg = computeAggregates([
      row({ event_id: 'e1', day_key: '2026-08-01', plant_id: 'pl-live' }),
      row({ event_id: 'e2', day_key: '2026-08-20', plant_id: 'pl-gone', gn_id: null }),
    ]);
    expect(cropOf(agg, 'tomato').hero_plant_id).toBe('pl-live');
  });

  it('leaves hero_plant_id null for a crop whose picks carry no planting at all', () => {
    const agg = computeAggregates([
      row({ event_id: 'e1', day_key: '2026-08-20', plant_id: null, gn_id: null }),
    ]);
    expect(cropOf(agg, 'tomato').hero_plant_id).toBeNull();
  });
});

describe('applyCropHeroPhotos — the merge that decides whether any photo renders', () => {
  const base = () => computeAggregates([
    row({ event_id: 'e1', day_key: '2026-08-20', plant_id: 'pl-tom', crop: 'tomato' }),
    row({ event_id: 'e2', day_key: '2026-08-22', plant_id: 'pl-bean', crop: 'bean' }),
  ]);

  it('lands each planting’s photo on ITS crop, not on whichever row was written last', () => {
    const agg = applyCropHeroPhotos(base(), [
      { plant_id: 'pl-bean', photo_id: 'ph-bean' },
      { plant_id: 'pl-tom', photo_id: 'ph-tom' },
    ]);
    expect(cropOf(agg, 'tomato').hero_photo_id).toBe('ph-tom');
    expect(cropOf(agg, 'bean').hero_photo_id).toBe('ph-bean');
  });

  it('gives EVERY crop the key, null included — absent and null must stay different facts', () => {
    const agg = applyCropHeroPhotos(base(), [{ plant_id: 'pl-tom', photo_id: 'ph-tom' }]);
    expect(cropOf(agg, 'bean')).toHaveProperty('hero_photo_id');
    expect(cropOf(agg, 'bean').hero_photo_id).toBeNull();
  });

  it('never invents a photo for a crop with no hero planting', () => {
    const agg = computeAggregates([row({ event_id: 'e1', day_key: '2026-08-20', plant_id: null, gn_id: null })]);
    applyCropHeroPhotos(agg, [{ plant_id: null, photo_id: 'ph-x' }]);
    expect(cropOf(agg, 'tomato').hero_photo_id).toBeNull();
  });

  it('tolerates an empty / absent rowset without throwing or half-writing', () => {
    expect(cropOf(applyCropHeroPhotos(base(), []), 'tomato').hero_photo_id).toBeNull();
    expect(cropOf(applyCropHeroPhotos(base(), undefined), 'tomato').hero_photo_id).toBeNull();
  });
});

// The merge above proves the JS. These prove the SQL that feeds it, which is the half that cannot be
// called: index.js is unimportable under the root run. Text assertions, and they are pinned to the
// two properties a wrong query would quietly lose.
describe('the hero photo query (static — index.js cannot be imported here)', () => {
  const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

  it('reaches BOTH photo attachment points — plant_id AND the planting’s events', () => {
    // blackberry is the live proof: 4 photos, all hanging off its harvest EVENTS, none on the plant
    // row. A plant_id-only fallback resolves 30 of 31 crops and misses exactly that one.
    expect(SRC).toMatch(/p\.plant_id = gn\.id OR pe\.plant_id = gn\.id/);
  });

  it('requires the featured photo to be ALIVE before preferring it over the fallback', () => {
    // Reading gn.featured_photo_id directly would emit an id for a soft-deleted photo, which can
    // only 404 — and 404 is terminal, so the row would render nothing instead of falling back.
    expect(SRC).toMatch(/LEFT JOIN photos fph ON fph\.id = gn\.featured_photo_id AND fph\.deleted_at IS NULL/);
    expect(SRC).toMatch(/COALESCE\(fph\.id, alt\.id\) AS photo_id/);
  });

  it('holds the I7 line: photo IDs only, no presign and no photos-bucket env in this Lambda', () => {
    expect(SRC).not.toMatch(/photo-access\.js/);
    expect(SRC).not.toMatch(/S3_PHOTOS/);
    expect(SRC).not.toMatch(/getSignedUrl|GetObjectCommand/);
  });
});

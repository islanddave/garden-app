// V4-SHAREALTTEXT-001 — the derived alt_text_custom on the two live Facebook Graph publish paths.
//
// Two layers, because only one of them can execute here — the same split, and the same caveat,
// as preparePhoto.test.js. index.js imports @neondatabase/serverless, @clerk/backend and two AWS
// SDK clients at module scope; none are in the ROOT package.json, and vi.mock cannot rescue that
// because Vite resolves the specifier before any mock applies.
//
//   Layer 1 runs the real derivation over real-shaped rows and proves what the string says.
//   Layer 2 is a SOURCE-TEXT guard on the two call sites — it asserts the shape of the code, not
//   its behaviour, and is labelled that way so nobody reads it as more than it is.
//
// A third block pins the copied naming rules to src/lib/harvestPost.js by PARITY rather than by
// byte-equality (the per-Lambda zip means the module cannot be imported, and only its naming subset
// was copied). That is the drift guard harvestPost's own isUncertainName comment asks for.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPhotoAltText, composeSubject, isUncertainName, normalizeVarietyName, pluralizeCrop,
  EVENT_SCENE_KEYS, MAX_ALT_TEXT,
} from './altText.js';
import * as post from '../../src/lib/harvestPost.js';
import { EVENT_TYPES } from '../../src/lib/eventTypes.js';

const here = dirname(fileURLToPath(import.meta.url));

// ── LAYER 1: real derivation over real-shaped rows ───────────────────────────────────────────────
// Names below are live prod values quoted in src/lib/harvestPost.js's own header comments, not
// invented fixtures — "Onion — scallion-type (thick blue-green, ID pending)", "San Marzano Roma",
// "Cherokee Green (Rescue)", "Czech's Bush" are the cases that surface corpus actually contains.
describe('buildPhotoAltText — derives the description from the record', () => {
  it('names the variety and the crop, and says what the photo shows', () => {
    expect(buildPhotoAltText({
      planting_name: 'Sun Gold', crop_name: 'Tomato', event_type: 'harvest',
    })).toBe('Sun Gold tomatoes, freshly harvested');
  });

  it('prefers the planting name over the cultivar name — it is the more specific record', () => {
    expect(buildPhotoAltText({
      planting_name: 'Sun Gold', variety_name: 'Cherry Tomato', crop_name: 'Tomato',
      event_type: 'flowering',
    })).toBe('Sun Gold tomatoes, in flower');
  });

  it('falls back to the cultivar name when the planting is unnamed', () => {
    expect(buildPhotoAltText({
      variety_name: 'Cubanelle', crop_name: 'Pepper', event_type: 'fruit_set',
    })).toBe('Cubanelle peppers, setting fruit');
  });

  it('applies the published-name override table, so alt text and caption agree', () => {
    expect(buildPhotoAltText({
      planting_name: 'San Marzano Roma', crop_name: 'Tomato', event_type: 'harvest',
    })).toBe('San Marzano tomatoes, freshly harvested');
  });

  it('strips a vendor suffix rather than publishing it', () => {
    expect(buildPhotoAltText({ planting_name: 'Granadero F1', crop_name: 'Tomato' }))
      .toBe('Granadero tomatoes');
  });

  it('drops a trailing bookkeeping parenthetical', () => {
    expect(buildPhotoAltText({ planting_name: 'Cherokee Green (Rescue)', crop_name: 'Tomato' }))
      .toBe('Cherokee Green tomatoes');
  });

  it('does not repeat a crop the name already carries', () => {
    expect(buildPhotoAltText({ planting_name: 'Cherry Tomato', crop_name: 'Tomato' }))
      .toBe('Cherry tomatoes');
  });

  it('says the crop once when the planting is named for it', () => {
    expect(buildPhotoAltText({ planting_name: 'Tomato', crop_name: 'Tomato' })).toBe('Tomatoes');
  });

  it('honours the invariant plural — "Zephyr squashes" is not a thing', () => {
    expect(buildPhotoAltText({ planting_name: 'Zephyr', crop_name: 'Squash' })).toBe('Zephyr squash');
  });
});

describe('buildPhotoAltText — what the photo shows, and what it does not', () => {
  it('adds no scene clause for an event that leaves nothing in the frame', () => {
    // A photo logged against a watering shows the plant, not the watering. Claiming otherwise is a
    // fabrication a screen-reader user is uniquely unable to check.
    for (const t of ['watering', 'fertilizing', 'moisture_check', 'rain', 'soil_amended']) {
      expect(buildPhotoAltText({ planting_name: 'Sun Gold', crop_name: 'Tomato', event_type: t }))
        .toBe('Sun Gold tomatoes');
    }
  });

  it('still describes the subject when the photo hangs off no event at all', () => {
    expect(buildPhotoAltText({ planting_name: 'Sun Gold', crop_name: 'Tomato', event_type: null }))
      .toBe('Sun Gold tomatoes');
  });

  it('ignores an event_type that is not in the taxonomy instead of interpolating it', () => {
    expect(buildPhotoAltText({ planting_name: 'Sun Gold', crop_name: 'Tomato', event_type: 'sploot' }))
      .toBe('Sun Gold tomatoes');
  });

  it('distinguishes the first harvest from the rest', () => {
    expect(buildPhotoAltText({ planting_name: 'Piri Piri', crop_name: 'Pepper', event_type: 'first_harvest' }))
      .toBe('Piri Piri peppers, the first harvest');
  });
});

describe('buildPhotoAltText — the empty case omits rather than fills', () => {
  it('returns null when the photo is attached to nothing', () => {
    expect(buildPhotoAltText({ id: 'abc', storage_path: 'photos/2026/abc.jpg' })).toBeNull();
  });

  it('returns null for blank, whitespace, and absent name fields', () => {
    expect(buildPhotoAltText({ planting_name: '   ', variety_name: '', crop_name: null })).toBeNull();
    expect(buildPhotoAltText({})).toBeNull();
    expect(buildPhotoAltText(null)).toBeNull();
    expect(buildPhotoAltText(undefined)).toBeNull();
  });

  it('returns null even when an event IS known — a scene with no subject is not a description', () => {
    // "freshly harvested" alone tells a screen-reader user nothing and occupies the slot a real
    // description would have used. Worse than silence, which is why this is null and not a clause.
    expect(buildPhotoAltText({ event_type: 'harvest' })).toBeNull();
    expect(buildPhotoAltText({ event_type: 'first_harvest', crop_name: '  ' })).toBeNull();
  });

  it('degrades an ID-uncertain name to the crop instead of publishing the uncertainty', () => {
    // A real prod value. Publishing it would assert an identification the data does not support;
    // the crop is a smaller claim that is still true.
    expect(buildPhotoAltText({
      planting_name: 'Onion — scallion-type (thick blue-green, ID pending)',
      crop_name: 'Onion (bunching / scallion)',
      event_type: 'harvest',
    })).toBe('Onions, freshly harvested');
  });

  it('returns null when the ONLY name is uncertain and no crop backs it up', () => {
    expect(buildPhotoAltText({ planting_name: 'Strawberry (unknown variety)' })).toBeNull();
  });
});

describe('buildPhotoAltText — never static, never the filename', () => {
  it('produces different text for different records', () => {
    const a = buildPhotoAltText({ planting_name: 'Sun Gold', crop_name: 'Tomato', event_type: 'harvest' });
    const b = buildPhotoAltText({ planting_name: 'Cubanelle', crop_name: 'Pepper', event_type: 'harvest' });
    const c = buildPhotoAltText({ planting_name: 'Sun Gold', crop_name: 'Tomato', event_type: 'flowering' });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('never leaks the storage path, the filename, or the photo id', () => {
    const row = {
      id: '3f9c1b7e-0000-4000-8000-0000000000aa',
      storage_path: 'photos/2026/08/IMG_4471.jpg',
      planting_name: 'Sun Gold', crop_name: 'Tomato', event_type: 'harvest',
    };
    const alt = buildPhotoAltText(row);
    expect(alt).toBe('Sun Gold tomatoes, freshly harvested');
    expect(alt).not.toContain(row.id);
    expect(alt).not.toContain('IMG_4471');
    expect(alt).not.toContain('.jpg');
    expect(alt).not.toContain('photos/');
  });

  it('never emits a bare generic — every non-null result carries a name or a crop', () => {
    const generic = /^(a )?photo( of)?( a)?( plant| garden)?\.?$/i;
    for (const t of [null, 'harvest', 'watering', 'flowering']) {
      const alt = buildPhotoAltText({ planting_name: 'Sun Gold', crop_name: 'Tomato', event_type: t });
      expect(alt).not.toMatch(generic);
      expect(alt.toLowerCase()).toContain('sun gold');
    }
  });
});

describe('buildPhotoAltText — bounded and crash-free on hostile record data', () => {
  it('caps length at a word boundary rather than mid-name', () => {
    const long = `${'Extremely Verbose Cultivar Name '.repeat(20)}End`;
    const full = composeSubject(long, 'Tomato');
    const alt = buildPhotoAltText({ planting_name: long, crop_name: 'Tomato' });
    expect(full.length).toBeGreaterThan(MAX_ALT_TEXT);     // the cap is actually exercised
    expect(alt.length).toBeLessThanOrEqual(MAX_ALT_TEXT);
    expect(alt.endsWith('…')).toBe(true);
    expect(alt).not.toMatch(/\s…$/);                       // trimmed, not "word …"

    // The kept text is a WHOLE-WORD prefix of the untruncated subject: no half-cultivar.
    const kept = alt.slice(0, -1);
    expect(full.startsWith(kept)).toBe(true);
    expect(full[kept.length]).toBe(' ');
  });

  it('leaves a normal description uncapped', () => {
    const alt = buildPhotoAltText({ planting_name: 'Sun Gold', crop_name: 'Tomato', event_type: 'harvest' });
    expect(alt.endsWith('…')).toBe(false);
    expect(alt.length).toBeLessThan(60);
  });

  it('does not throw when a crop name contains regex metacharacters', () => {
    // The crop reaches `new RegExp` in the suffix rule. Unescaped, "Pepper[" is a SyntaxError, and
    // this module runs inside the request path of the one endpoint that publishes outside the
    // household — the throw would 500 the whole post.
    for (const crop of ['Pepper[', 'Squash(', 'Tomato*', 'Corn+', 'Kale\\', 'Basil?']) {
      expect(() => buildPhotoAltText({ planting_name: 'Sun Gold', crop_name: crop })).not.toThrow();
    }
  });

  it('treats a non-textual column value as absent rather than publishing "[object Object]"', () => {
    expect(buildPhotoAltText({ planting_name: 42, crop_name: 'Tomato' })).toBe('42 tomatoes');
    expect(buildPhotoAltText({ planting_name: {}, crop_name: null })).toBeNull();
    expect(buildPhotoAltText({ planting_name: {}, crop_name: [], variety_name: {} })).toBeNull();
    expect(buildPhotoAltText({ planting_name: {}, crop_name: 'Tomato' })).toBe('Tomatoes');
  });
});

// ── The scene vocabulary is pinned to the real taxonomy ──────────────────────────────────────────
describe('EVENT_SCENE', () => {
  it('every key is a real EVENT_TYPES member', () => {
    // A typo fails SILENTLY as "no scene clause", so nothing else in this file would catch it.
    expect(EVENT_SCENE_KEYS.filter((k) => !EVENT_TYPES.includes(k))).toEqual([]);
  });

  it('is deliberately partial — the action-only event types are absent', () => {
    for (const t of ['watering', 'fertilizing', 'moisture_check', 'pest_treatment', 'soil_amended']) {
      expect(EVENT_SCENE_KEYS).not.toContain(t);
    }
    expect(EVENT_SCENE_KEYS.length).toBeLessThan(EVENT_TYPES.length);
    expect(EVENT_SCENE_KEYS.length).toBeGreaterThanOrEqual(15);
  });
});

// ── Parity with the canonical naming rules ───────────────────────────────────────────────────────
// altText.js copies the naming subset of src/lib/harvestPost.js because a ../../src import is not
// packaged into this Lambda's zip. Byte-equality is impossible (only a subset was copied), so the
// guard is behavioural: if either side's tables or rules move, these go red.
describe('naming parity with src/lib/harvestPost.js (the canonical public-output surface)', () => {
  const NAMES = [
    'San Marzano Roma', "Czech's Bush", 'Czech’s Bush', 'Chilly Chill', 'Granadero F1',
    'Cherokee Green (Rescue)', 'Scallion (thin clump)', 'Sun Gold', 'Cubanelle', 'Piri Piri',
    'Armageddon', 'Zephyr', 'Summer Squash', 'Cherry Tomato', 'Beefsteak (Burpee)', 'Amish Heirloom',
    'Strawberry (unknown variety)', 'Onion — scallion-type (thick blue-green, ID pending)',
    'Something TBD', 'Mystery (?)', '', '   ',
  ];
  const CROPS = [
    'Tomato', 'Pepper', 'Squash', 'Onion', 'Kale', 'Corn', 'Potato', 'Tomatillo', 'Broccoli',
    'Onion (bunching / scallion)', 'Summer Squash', 'Cherry Tomato', '',
  ];

  it('isUncertainName agrees on every name in the corpus', () => {
    for (const n of NAMES) expect([n, isUncertainName(n)]).toEqual([n, post.isUncertainName(n)]);
  });

  it('normalizeVarietyName agrees on every name in the corpus', () => {
    for (const n of NAMES) {
      expect([n, normalizeVarietyName(n)]).toEqual([n, post.normalizeVarietyName(n)]);
    }
  });

  it('pluralizeCrop agrees on every crop, singular and plural', () => {
    for (const c of CROPS) {
      for (const q of [1, 2, 7]) {
        expect([c, q, pluralizeCrop(c, q)]).toEqual([c, q, post.pluralizeCrop(c, q)]);
      }
    }
  });

  it('composeSubject is renderLine({withCrop:true}) with the quantity dropped', () => {
    // The ONE intentional divergence is leading case: a post line is preceded by a number
    // ("2 tomatoes"), alt text stands alone and opens the phrase ("Tomatoes"). Compared
    // case-insensitively for exactly that reason; every other character must match.
    for (const rawName of NAMES) {
      for (const crop of CROPS) {
        const name = post.isUncertainName(rawName) ? '' : post.normalizeVarietyName(rawName);
        const line = post.renderLine({ name, crop, quantity: 2 }, { withCrop: true });
        const expected = line.replace(/^2\s*/, '');
        expect([rawName, crop, composeSubject(name, crop).toLowerCase()])
          .toEqual([rawName, crop, expected.toLowerCase()]);
      }
    }
  });
});

// ── LAYER 2: SOURCE-TEXT GUARD on index.js — asserts shape, never behaviour ──────────────────────
describe('index.js Graph call sites carry the alt text (SOURCE-TEXT guard — shape, not behaviour)', () => {
  const src = readFileSync(join(here, 'index.js'), 'utf8');

  it('the anchors still resolve — a stale read would make every assertion below vacuous', () => {
    expect(src).toContain('async function share(');
    expect(src).toContain('graphMultipart(photoUploadUrl(pageId)');
    expect(src.length).toBeGreaterThan(5000);
  });

  it('imports the derivation rather than inlining a string in the handler', () => {
    expect(src).toMatch(/import\s*\{\s*buildPhotoAltText\s*\}\s*from\s*'\.\/altText\.js'/);
  });

  it('derives the alt from the record row on the prepared photo', () => {
    expect(src).toMatch(/alt:\s*buildPhotoAltText\(row\)/);
  });

  it('SELECTs the descriptive columns the derivation needs', () => {
    // Without these the derivation runs on { id, storage_path } and every photo returns null.
    const select = src.slice(src.indexOf('const rows = await sql'), src.indexOf('const byId'));
    for (const col of ['planting_name', 'variety_name', 'crop_name', 'event_type']) {
      expect(select).toContain(col);
    }
    for (const rel of ['event_log', 'garden_node', 'cultivar', 'crop_types']) {
      expect(select).toContain(rel);
    }
  });

  it('keeps the added joins LEFT, so a photo with no planting still posts', () => {
    const select = src.slice(src.indexOf('const rows = await sql'), src.indexOf('const byId'));
    const joins = select.match(/\b(LEFT JOIN|INNER JOIN|JOIN)\b/g) ?? [];
    expect(joins.length).toBe(4);
    expect(joins.every((j) => j === 'LEFT JOIN')).toBe(true);
  });

  it('sends alt_text_custom on BOTH publish paths — single and multi', () => {
    const single = src.indexOf("['published', 'true']");
    const multi = src.indexOf("['published', 'false']");
    expect(single).toBeGreaterThan(-1);
    expect(multi).toBeGreaterThan(-1);

    // The field list each call site builds, back to its own graphMultipart(.
    const fieldsBefore = (at) => src.slice(src.lastIndexOf('graphMultipart(photoUploadUrl(pageId)', at), at);
    expect(fieldsBefore(single)).toContain('...altField(p.alt)');
    expect(fieldsBefore(multi)).toContain('...altField(p.alt)');
  });

  it('names the Graph field alt_text_custom exactly once, in the shared helper', () => {
    expect(src.match(/alt_text_custom'/g) ?? []).toHaveLength(1);
    const fn = src.slice(src.indexOf('function altField('));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain("alt_text_custom");
  });

  it('OMITS the field when no description was derivable, never sending an empty one', () => {
    const fn = src.slice(src.indexOf('function altField('));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    expect(body.length).toBeGreaterThan(50);
    expect(body).toMatch(/return\s+a\s*\?\s*\[\[\s*'alt_text_custom'\s*,\s*a\s*\]\]\s*:\s*\[\]/);
  });

  it('does not put per-image text on the /feed call, which is post-level', () => {
    // Bound is ']);' — the close of the feed call's OWN field-list argument — not '];'.
    //
    // The feed call ends `]);`, so a '];' bound never matched inside it and ran on to the next '];'
    // ANYWHERE later in the file: measured at 11,777 characters, over half of index.js, sweeping in
    // cleanupOrphans, readBackAssert and every comment after them. It passed only because no word
    // containing "alt" happened to appear in that whole region, and it went red the moment an
    // unrelated function's COMMENT used the word — a false positive on prose, while never once
    // examining the 161 characters the test is named for. Tightening the bound is what makes this
    // assert its own title; the region it now reads is the feed call and nothing else.
    const feed = src.slice(src.indexOf('graphMultipart(feedUrl(pageId)'));
    const call = feed.slice(0, feed.indexOf(']);') + 3);
    expect(call).toContain('attachedMediaFields');   // we are looking at the right call
    expect(call.length).toBeLessThan(400);           // ...and only at that call
    expect(call).not.toContain('alt');
  });
});

// The runtime helper is pure and lives in index.js (it is three lines and has no other consumer), so
// its behaviour is asserted here through the same source the guard above reads — a literal
// re-declaration would be a copy that could pass while the real one drifted. This block executes an
// extracted copy ONLY to pin the empty-case contract; the shape guard above is what ties it to prod.
describe('altField empty-case contract (executed from the real source)', () => {
  // Extracted lazily, per call. Doing it at describe-scope makes a missing or renamed altField a
  // COLLECTION error that takes the whole file down with one opaque ReferenceError, hiding which
  // guards above actually broke — measured while proving these tests non-vacuous.
  const altField = (...args) => {
    const src = readFileSync(join(here, 'index.js'), 'utf8');
    const at = src.indexOf('function altField(');
    if (at < 0) throw new Error('index.js no longer declares altField — the alt text is not wired in');
    const fnSrc = src.slice(at);
    return new Function(`${fnSrc.slice(0, fnSrc.indexOf('\n}\n') + 2)}\nreturn altField;`)()(...args);
  };

  it('emits one field for a real description', () => {
    expect(altField('Sun Gold tomatoes, freshly harvested'))
      .toEqual([['alt_text_custom', 'Sun Gold tomatoes, freshly harvested']]);
  });

  it('emits NOTHING for null, undefined, empty, or whitespace', () => {
    for (const v of [null, undefined, '', '   ', '\n\t']) expect(altField(v)).toEqual([]);
  });

  it('emits nothing for a non-string, rather than stringifying it into the post', () => {
    for (const v of [0, 42, {}, [], true]) expect(altField(v)).toEqual([]);
  });
});

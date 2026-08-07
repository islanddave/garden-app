// BUG-COALESCECLEAR-001 — the locations clear:[] channel.
//
// EXACTLY ONE of this PUT's five COALESCE arms is clearable, and that is the finding rather than a
// shortfall. Three arms are NOT NULL; the fourth (type_label) is a care-engine input. The value of
// this file is mostly in what it REFUSES.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEARABLE_FIELDS, CLEARABLE_SET, validateClear } from './validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

const FORBIDDEN = {
  name: 'NOT NULL, and itself a coverage input — l.name in (Stable, House) covers 26 live plantings',
  type_label: 'the coverage input — clearing it on Shelf 4 opts 15 indoor plantings into every frost alert',
  is_active: 'NOT NULL DEFAULT true — false is a value, not a clear',
  sort_order: 'NOT NULL DEFAULT 0 — clear-to-zero already works through the plain COALESCE arm',
  featured_photo_id: 'already CASE-clearable via its own hasFeatured sentinel',
  lat: 'not a PUT arm, and chk_lat_lng_co_null is VALIDATED — lat/lng clear as a PAIR or not at all',
  lng: 'not a PUT arm, and chk_lat_lng_co_null is VALIDATED — lat/lng clear as a PAIR or not at all',
};

describe('BUG-COALESCECLEAR-001: locations clear allowlist', () => {
  it('names exactly one column', () => {
    expect([...CLEARABLE_FIELDS]).toEqual(['description']);
  });

  it.each(Object.entries(FORBIDDEN))('never admits %s — %s', (col) => {
    expect(CLEARABLE_SET.has(col)).toBe(false);
    expect(validateClear([col], {})).toMatch(/cannot be cleared/);
  });

  it('type_label stays excluded even though NOLOCOUTDOOR removed the care regression', () => {
    // The reason CHANGED and the verdict did not, so pin both — otherwise a future reader finds the
    // old rationale disproved and assumes the exclusion lapsed with it.
    //
    // Before BUG-NOLOCOUTDOOR-001: clearing type_label collapsed 16 plantings to covered=false =
    // OUTDOOR — rain credit under a roof, and dropped from the frost pass. A silent CARE regression.
    // After it: a NULL type_label resolves to UNKNOWN, which fails safe in both directions.
    //
    // What remains is ALERT NOISE, not plant harm: unknown means "not covered" for frost, so
    // clearing type_label opts up to 16 indoor plantings into every frost alert with no visible
    // signal. That is Dave's product call, not a correctness one, so it stays off the list until he
    // makes it. Adding it later is one line here plus one SQL arm.
    expect(CLEARABLE_SET.has('type_label')).toBe(false);
  });

  it('lat and lng are refused INDIVIDUALLY — the CHECK is a pair constraint', () => {
    // chk_lat_lng_co_null is VALIDATED: clearing one alone is a guaranteed 23514. If a coordinate
    // edit surface is ever added it needs a resolveLatLngPair() in the shape of events'
    // resolveFlagPair(), NOT two independent entries on this list.
    expect(validateClear(['lat'], {})).toMatch(/cannot be cleared/);
    expect(validateClear(['lng'], {})).toMatch(/cannot be cleared/);
    expect(validateClear(['lat', 'lng'], {})).toMatch(/cannot be cleared/);
  });
});

describe('BUG-COALESCECLEAR-001: locations validateClear contract', () => {
  it('absent / null / [] are the legacy no-op', () => {
    expect(validateClear(undefined, {})).toBeNull();
    expect(validateClear(null, {})).toBeNull();
    expect(validateClear([], {})).toBeNull();
  });

  it('rejects a non-array', () => {
    expect(validateClear('description', {})).toMatch(/must be an array/);
  });

  it('rejects clearing and setting the same key', () => {
    expect(validateClear(['description'], { description: 'x' })).toMatch(/both cleared and set/);
  });

  it('allows clear alongside an explicit null for the same key', () => {
    expect(validateClear(['description'], { description: null })).toBeNull();
  });
});

describe('BUG-COALESCECLEAR-001: locations SQL arms match the allowlist', () => {
  it('description has exactly one CASE arm', () => {
    const token = "@> ARRAY['description']";
    expect(SRC.split(token).length - 1, `${token} must appear exactly once`).toBe(1);
  });

  it('no FORBIDDEN column has a clear arm — type_label above all', () => {
    for (const col of Object.keys(FORBIDDEN)) {
      expect(SRC, `locations/index.js must not carry a clear arm for ${col}`)
        .not.toContain(`@> ARRAY['${col}']`);
    }
  });

  it('the name and type_label arms remain plain COALESCE, untouched by the channel', () => {
    // Guards the other direction: the channel must not have quietly rewritten a non-clearable arm.
    expect(SRC).toMatch(/name\s*=\s*COALESCE\(\$\{body\.name \?\? null\}, name\)/);
    expect(SRC).toMatch(/type_label\s*=\s*COALESCE\(\$\{body\.type_label \?\? null\}, type_label\)/);
  });

  it('maps the constraint codes its siblings map', () => {
    // This catch mapped ONLY 23505 before BUG-COALESCECLEAR-001's audit — the one handler that
    // never adopted the sibling pattern, so a caller-provokable violation read "Internal server
    // error" with no message.
    expect(SRC).toContain("err.code === '23503'");
    expect(SRC).toContain("err.code === '23514'");
  });
});

// BUG-COALESCECLEAR-001 — the client half.
//
// The server channel is INERT without this. Before this helper, exactly one client surface
// (EventDetail) sent `clear`, so the plants / projects / locations / varieties channels were
// reachable only by hand-written curl: every edit form sent `field.trim() || null`, the server read
// that as absent, and emptying a box returned 200 with no change. That is the user-visible bug, and
// it survived the server fix.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBlank, buildClearKeys, clearPatch, SERVER_CLEARABLE } from '../lib/clearKeys.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = (p) => resolve(__dirname, '../../', p);

describe('isBlank — emptiness is NOT falsiness', () => {
  it('treats empty and whitespace-only strings as blank', () => {
    for (const v of ['', '   ', '\t', '\n', null, undefined]) expect(isBlank(v)).toBe(true);
  });

  it('does NOT treat 0 or false as blank', () => {
    // The whole reason this is a named function and not `!v`. sort_order 0 and is_public false are
    // VALUES; a falsiness test would clear them and silently destroy real data — the mirror image
    // of the bug being fixed, and a worse one.
    expect(isBlank(0)).toBe(false);
    expect(isBlank(false)).toBe(false);
  });
});

describe('buildClearKeys — the safety rule', () => {
  const saved = { description: 'old', variety: 'Beefsteak', start_date: '2026-01-01', secret: 'untouched' };

  it('clears a field that HELD a value and is now empty', () => {
    expect(buildClearKeys(['description'], { description: '' }, saved)).toEqual(['description']);
    expect(buildClearKeys(['description'], { description: '   ' }, saved)).toEqual(['description']);
  });

  it('does NOT clear a field that is unchanged', () => {
    expect(buildClearKeys(['description'], { description: 'old' }, saved)).toEqual([]);
  });

  it('does NOT clear a field that was ALREADY null — no pointless re-clear every save', () => {
    expect(buildClearKeys(['notes'], { notes: '' }, { notes: null })).toEqual([]);
  });

  it('NEVER clears a key the form does not render — the mirror-image bug', () => {
    // A form rendering 3 of a table's 30 columns must not be able to NULL the other 27. This is the
    // single most important assertion in this file: getting it wrong destroys data rather than
    // failing to save it.
    expect(buildClearKeys(['description'], { description: '' }, saved)).not.toContain('secret');
    expect(buildClearKeys([], { description: '' }, saved)).toEqual([]);
  });

  it('drops a key the server will not accept, rather than sending it', () => {
    // A rejected key 400s the WHOLE request, losing the user's other edits with it. Dropping it
    // client-side keeps the save working and matches the server's own verdict.
    const out = buildClearKeys(['description', 'type_label'],
      { description: '', type_label: '' },
      { description: 'x', type_label: 'shelf' },
      { allowed: SERVER_CLEARABLE.locations });
    expect(out).toEqual(['description']);
    expect(out).not.toContain('type_label');
  });

  it('is defensive about missing arguments', () => {
    expect(buildClearKeys(null, {}, {})).toEqual([]);
    expect(buildClearKeys(['a'], null, {})).toEqual([]);
    expect(buildClearKeys(['a'], {}, null)).toEqual([]);
  });
});

describe('clearPatch — a save with nothing to clear is byte-identical to before', () => {
  it('omits the key entirely when there is nothing to clear', () => {
    // Byte-identity is what lets this ship without re-testing every existing save path.
    expect(clearPatch(['description'], { description: 'same' }, { description: 'same' })).toEqual({});
    expect(Object.keys(clearPatch(['x'], { x: 'v' }, { x: 'v' }))).toHaveLength(0);
  });

  it('adds clear only when non-empty', () => {
    expect(clearPatch(['description'], { description: '' }, { description: 'old' }))
      .toEqual({ clear: ['description'] });
  });
});

describe('SERVER_CLEARABLE mirrors the server allowlists exactly', () => {
  // Read the server validators FROM DISK. A drift here sends a key the server 400s, which the user
  // experiences as "my edit did not save" with an error naming a column — worse than the original
  // silent no-op. Parsing the literal is deliberate: importing the Lambda module would pull its
  // whole dependency graph into the client test run.
  const declared = (file) => {
    const src = readFileSync(repo(file), 'utf8');
    const m = src.match(/CLEARABLE_FIELDS\s*=\s*\[([\s\S]*?)\]/);
    expect(m, `${file} must declare CLEARABLE_FIELDS`).toBeTruthy();
    return [...m[1].matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((x) => x[1]);
  };

  it('projects', () => {
    expect([...SERVER_CLEARABLE.projects].sort())
      .toEqual(declared('lambda/projects/validate.js').sort());
  });

  it('locations', () => {
    expect([...SERVER_CLEARABLE.locations].sort())
      .toEqual(declared('lambda/locations/validate.js').sort());
  });

  it('plants', () => {
    expect([...SERVER_CLEARABLE.plants].sort())
      .toEqual(declared('lambda/plants/validate.js').sort());
  });

  // The tier-2 exclusions are the risk control, so pin the three that would change a care
  // recommendation on clear. If the server ever adds one, this reds and forces the paired engine
  // fix to be a decision rather than a side effect of editing a list.
  it('plants excludes the tier-2 care-engine inputs', () => {
    for (const col of ['status', 'container_type', 'transplanted_at', 'planted_out_at']) {
      expect(SERVER_CLEARABLE.plants).not.toContain(col);
      expect(declared('lambda/plants/validate.js')).not.toContain(col);
    }
  });

  // varieties is deliberately NOT in SERVER_CLEARABLE — VarietyEditor builds `clear` itself from
  // its FIELDS table. The invariant that matters there is containment, not equality: a rendered
  // field the server will not clear makes the server 400 the WHOLE save, losing every other edit
  // the user just made. Equality would be wrong — the server allows photo_id, which no form renders.
  it('every VarietyEditor FIELDS key is server-clearable', () => {
    const src = readFileSync(repo('src/components/forms/VarietyEditor.jsx'), 'utf8');
    const fields = [...src.matchAll(/\{\s*key:\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((x) => x[1]);
    expect(fields.length).toBeGreaterThanOrEqual(25);
    const allowed = new Set(declared('lambda/varieties/validate.js'));
    // crop_type_slug is pushed by hand in buildVarietyPatch rather than via FIELDS, so it has to
    // clear the same bar.
    expect([...fields, 'crop_type_slug'].filter((k) => !allowed.has(k))).toEqual([]);
  });

  it('locations does NOT include type_label — the care-engine input', () => {
    // Pinned on both sides. If the server ever adds it, this reds and forces a deliberate decision
    // here rather than the client silently gaining the ability to opt 16 plantings into frost alerts.
    expect(SERVER_CLEARABLE.locations).not.toContain('type_label');
    expect(declared('lambda/locations/validate.js')).not.toContain('type_label');
  });
});

describe('the forms actually send it', () => {
  // Without this, the helper can be perfect and the feature still dead — which is precisely the
  // state the server channel shipped in.
  it.each([
    ['src/pages/ProjectDetail.jsx', 'SERVER_CLEARABLE.projects'],
    ['src/pages/Locations.jsx', 'SERVER_CLEARABLE.locations'],
    ['src/components/PlantingEditor.jsx', 'SERVER_CLEARABLE.plants'],
  ])('%s calls clearPatch with the matching allowlist', (file, allowlist) => {
    const src = readFileSync(repo(file), 'utf8');
    expect(src).toContain('clearPatch(');
    expect(src).toContain(allowlist);
  });

  // The render manifest is the safety rule made concrete: clearPatch may only be handed keys the
  // form actually shows. PlantingEditor derives its form from formFromPlant, so the two must agree
  // key-for-key — a field added to one and not the other either silently keeps the old no-op
  // behaviour (manifest missing) or hands the helper a key with no input behind it (manifest extra).
  it('PLANT_FORM_FIELDS matches formFromPlant key-for-key', () => {
    const src = readFileSync(repo('src/components/PlantingEditor.jsx'), 'utf8');
    const manifest = src.match(/const PLANT_FORM_FIELDS = \[([\s\S]*?)\]/);
    expect(manifest, 'PlantingEditor must declare PLANT_FORM_FIELDS').toBeTruthy();
    const declaredKeys = [...manifest[1].matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((x) => x[1]);

    const fromPlant = src.match(/function formFromPlant\(plant\) \{\s*return \{([\s\S]*?)\n  \}/);
    expect(fromPlant, 'PlantingEditor must declare formFromPlant').toBeTruthy();
    const formKeys = [...fromPlant[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):/gm)].map((x) => x[1]);

    expect(formKeys.length).toBeGreaterThanOrEqual(15);
    expect([...declaredKeys].sort()).toEqual([...formKeys].sort());
  });
});

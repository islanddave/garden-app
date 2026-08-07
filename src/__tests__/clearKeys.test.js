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
  ])('%s calls clearPatch with the matching allowlist', (file, allowlist) => {
    const src = readFileSync(repo(file), 'utf8');
    expect(src).toContain('clearPatch(');
    expect(src).toContain(allowlist);
  });
});

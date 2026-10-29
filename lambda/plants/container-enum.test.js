// BUG-CONTVAL-001 static-source guard: the plants Lambda ALLOWED_CONTAINER enum
// must stay in lockstep with the live DB CHECK chk_plants_container_type (14 values,
// verified against prod 2026-07-01) and the frontend PLANT_CONTAINER_TYPE_OPTIONS.
// Regression class L-091 (constraint-vs-code drift); the stale 10-value list rejected
// valid `trough` plantings (8 live rows) at the add-planting API.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decommentSqlDashSpace as decomment } from '../_test-stubs/handlerSource.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
// BUG-AUTHZLAMBDA-001: the list moved out of the PUT/POST handlers into validate.js as ONE exported
// literal, shared by PUT, POST and the merge route. The literal is parsed from validate.js; index.js
// must import it and carry no local copy.
const VALIDATE_SRC = decomment(readFileSync(resolve(__dirname, 'validate.js'), 'utf8'));
const REQUIRED = ['fabric_bag','plastic_pot','terracotta','ceramic','raised_bed','in_ground','tray_cell','hanging_basket','window_box','trough','whiskey_barrel','soil_block','solo_cup','other'];
const quoted = (s) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const sorted = (a) => [...a].sort();

/** The source from the first `from` up to the next `to` (or to the end). */
const between = (src, from, to) => {
  const a = src.indexOf(from);
  if (a < 0) return '';
  const b = to ? src.indexOf(to, a + from.length) : -1;
  return b < 0 ? src.slice(a) : src.slice(a, b);
};

describe('BUG-CONTVAL-001 container_type enum parity', () => {
  it('validate.js exports exactly ONE ALLOWED_CONTAINER literal', () => {
    const defs = [...VALIDATE_SRC.matchAll(/export const ALLOWED_CONTAINER\s*=\s*\[([^\]]*)\]/g)];
    expect(defs).toHaveLength(1);
  });
  it('that literal is the SAME SET as the live DB CHECK (incl. trough) — not a superset, not a subset', () => {
    const m = VALIDATE_SRC.match(/ALLOWED_CONTAINER\s*=\s*\[([^\]]*)\]/);
    expect(m).toBeTruthy();
    expect(sorted(quoted(m[1]))).toEqual(sorted(REQUIRED));
  });
  it('index.js defines no local copy and imports the shared list', () => {
    expect((SRC.match(/ALLOWED_CONTAINER\s*=/g) || [])).toHaveLength(0);
    expect(SRC).toMatch(/import\s*\{[^}]*\bALLOWED_CONTAINER\b[^}]*\}\s*from\s*'\.\/validate\.js'/);
  });
  it('PUT, POST and the merge route all check container_type against it', () => {
    // One check per writer: body.container_type on PUT and POST, the override map on merge.
    const body = [...SRC.matchAll(/body\.container_type != null && !ALLOWED_CONTAINER\.includes\(body\.container_type\)/g)];
    expect(body).toHaveLength(2);
    const merge = between(SRC, 'if (mergeMatch) {', 'await mergeCore(');
    expect(merge).toMatch(/ov\.container_type != null && !ALLOWED_CONTAINER\.includes\(ov\.container_type\)/);
  });
});

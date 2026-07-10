// V4-SEEDINV-001 — varieties Lambda column-plumbing regression guard.
// Static-source assertion (modeled on lambda/plants/select-columns.test.js) that every
// read/write clause in lambda/varieties/index.js carries the 14 columns added by
// migrations/v4-seedinv-001/0a (3 classify + 11 sow), which public.cultivar exposes
// with identical names.
//
// Why static: lambda/varieties/index.js imports @neondatabase/serverless +
// @clerk/backend + @aws-sdk/* at module load time, so importing it here would drag
// runtime deps into unit tests (integration-only). Static source inspection is the
// lowest-risk regression gate for the bug class this guards against (Anomaly #A /
// L-091/L-190 family: POST persisted, GET SELECT did not list new columns —
// write->read symmetry silently broken).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

// Per migrations/v4-seedinv-001/0a-additive-ddl.sql: 3 v4-classify columns re-added
// (base-only until this migration widens the view) + 11 sow-profile columns.
const SEEDINV_COLUMNS = [
  'determinacy', 'day_length_response', 'grown_as',
  'start_method', 'start_indoor_weeks_min', 'start_indoor_weeks_max',
  'direct_sow_timing', 'sow_depth_in', 'seed_spacing_in', 'row_spacing_in',
  'days_to_germ_min', 'days_to_germ_max', 'sow_season', 'sow_notes',
];

// Extract each SELECT...FROM public.cultivar block from the source. Five exist:
// by-id GET, list GET (with q), list GET (without q), POST idempotent-by-source-id,
// and the POST fuzzy-match probe (id/name/species/genus only — intentionally narrow,
// excluded below by the days_to_maturity_min filter). SELECT set_config(...) has no
// FROM and the crop-types vocab SELECT binds public.crop_types, so neither matches.
function extractSelectBlocks(src) {
  const re = /SELECT\s+((?:(?!\bFROM\b)[\s\S])*?)\s+FROM\s+public\.cultivar/g;
  const blocks = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

describe('varieties Lambda SEEDINV column plumbing (static-source guard)', () => {
  const allSelects = extractSelectBlocks(SRC);
  // Full-row reads = the blocks that project the whole variety shape.
  const fullSelects = allSelects.filter((b) => /\bdays_to_maturity_min\b/.test(b));

  it('exposes exactly 4 full-row SELECT...FROM public.cultivar blocks (by-id + list+q + list-all + idempotent POST)', () => {
    expect(fullSelects.length).toBe(4);
  });

  for (const col of SEEDINV_COLUMNS) {
    it(`every full-row SELECT block includes ${col}`, () => {
      for (const [idx, block] of fullSelects.entries()) {
        const present = new RegExp(`\\b${col}\\b`).test(block);
        expect(present, `SELECT block #${idx} missing ${col}`).toBe(true);
      }
    });
  }

  // INSERT column list: between "INSERT INTO public.cultivar (" and ") VALUES".
  const insertMatch = SRC.match(/INSERT INTO public\.cultivar \(([\s\S]*?)\) VALUES \(([\s\S]*?)\) RETURNING/);
  it('has exactly one INSERT INTO public.cultivar', () => {
    expect(insertMatch).not.toBeNull();
    expect((SRC.match(/INSERT INTO public\.cultivar/g) || []).length).toBe(1);
  });

  for (const col of SEEDINV_COLUMNS) {
    it(`INSERT column list includes ${col}`, () => {
      expect(new RegExp(`\\b${col}\\b`).test(insertMatch[1]), `INSERT column list missing ${col}`).toBe(true);
    });
    it(`INSERT VALUES binds body.${col}`, () => {
      expect(insertMatch[2].includes(`body.${col}`), `INSERT VALUES missing \${body.${col} ?? null}`).toBe(true);
    });
  }

  // RETURNING lists: PUT UPDATE + POST INSERT both return the full row shape
  // (the DELETE RETURNING id is excluded by the display_name filter).
  const returningLists = [...SRC.matchAll(/RETURNING ([^\n`]+)/g)]
    .map((m) => m[1])
    .filter((r) => r.includes('display_name AS name'));

  it('exposes exactly 2 full-row RETURNING lists (PUT + INSERT)', () => {
    expect(returningLists.length).toBe(2);
  });

  for (const col of SEEDINV_COLUMNS) {
    it(`both RETURNING lists include ${col}`, () => {
      for (const [idx, list] of returningLists.entries()) {
        const present = new RegExp(`\\b${col}\\b`).test(list);
        expect(present, `RETURNING list #${idx} missing ${col}`).toBe(true);
      }
    });
  }

  // PUT partial-update block: the single UPDATE...SET containing COALESCE assignments
  // (the DELETE soft-delete UPDATE has no COALESCE and is filtered out).
  const coalesceBlocks = [...SRC.matchAll(/UPDATE public\.cultivar\s+SET([\s\S]*?)WHERE/g)]
    .map((m) => m[1])
    .filter((b) => b.includes('COALESCE'));

  it('exposes exactly 1 COALESCE UPDATE block (PUT)', () => {
    expect(coalesceBlocks.length).toBe(1);
  });

  for (const col of SEEDINV_COLUMNS) {
    it(`PUT COALESCE block partial-updates ${col}`, () => {
      const block = coalesceBlocks[0] ?? '';
      const assignment = new RegExp(`\\b${col}\\s*=\\s*COALESCE\\(\\$\\{body\\.${col} \\?\\? null\\}, ${col}\\)`);
      expect(assignment.test(block), `PUT COALESCE missing ${col} = COALESCE(\${body.${col} ?? null}, ${col})`).toBe(true);
    });
  }

  // display_name AS name aliasing must survive the widening in every full-row read
  // and both write RETURNINGs (JSON contract: API key is "name").
  it('every full-row SELECT block still aliases display_name AS name', () => {
    for (const [idx, block] of fullSelects.entries()) {
      expect(/\bdisplay_name AS name\b/.test(block), `SELECT block #${idx} missing display_name AS name`).toBe(true);
    }
  });
  it('both RETURNING lists still alias display_name AS name', () => {
    for (const list of returningLists) {
      expect(/\bdisplay_name AS name\b/.test(list)).toBe(true);
    }
  });
});

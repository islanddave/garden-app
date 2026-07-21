// HOUSEHOLD-MODE static-source guard (photos Lambda) — uploaded_by -> created_by SWITCH.
// Photos previously scoped by uploaded_by = ${userId}; Household Mode switches the SCOPE
// FILTERS to created_by = ANY(${householdIds}) (created_by is canonical, populated).
// uploaded_by survives ONLY as a display/INSERT column. Static-source (L-072), DB-free.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

describe('photos Lambda — Household Mode uploaded_by -> created_by switch', () => {
  it('imports householdScope + computes householdIds', () => {
    expect(SRC).toMatch(/import \{ householdScope \} from '\.\/household\.js'/);
    expect(SRC).toMatch(/const householdIds = householdScope\(userId\)/);
  });

  it('NO uploaded_by scope filter remains (only INSERT column survives)', () => {
    // view-url SELECT, both LIST SELECTs, and the re-tag UPDATE guard all switched.
    expect(SRC).not.toMatch(/uploaded_by = \$\{userId\}/);
    expect(SRC).not.toMatch(/p\.uploaded_by = \$\{userId\}/);
    // The INSERT column list still names uploaded_by (display/author column).
    // `[,)]` not `)`: V4-PHOTOBULK-001 appended capture-metadata columns after created_by, so
    // created_by is no longer the LAST column. That was incidental to this guard — the invariant
    // is that uploaded_by and created_by are both still bound, not their position in the list.
    expect(SRC).toMatch(/uploaded_by, created_by[,)]/);
  });

  it('scope filters + cross-entity featured-photo guards use created_by = ANY(${householdIds})', () => {
    // 4 switched (view-url, 2 list, re-tag) + 3 cross-entity PATCH guards = 7.
    const matches = SRC.match(/created_by = ANY\(\$\{householdIds\}\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(7);
  });

  it('UPDATE locations auto-promote block left UNTOUCHED (backfill-gated, out of scope)', () => {
    const locIdx = SRC.indexOf('UPDATE locations');
    expect(locIdx).toBeGreaterThan(-1);
    const block = SRC.slice(locIdx, locIdx + 320);
    expect(block).not.toMatch(/created_by/);
    expect(block).not.toMatch(/householdIds/);
  });

  it('INSERT still binds uploaded_by + created_by = ${userId}', () => {
    const insIdx = SRC.indexOf('INSERT INTO photos');
    // Window widened 600 -> 1200: the INSERT grew by 8 capture-metadata columns
    // (V4-PHOTOBULK-001) and the old window no longer reached the end of the statement, so the
    // householdIds negative assertion below was scanning a truncated block.
    const block = SRC.slice(insIdx, insIdx + 1200);
    expect(block).toMatch(/uploaded_by, created_by[,)]/);
    expect(block).not.toMatch(/householdIds/);
  });

  it('no array spread (42P18 guard)', () => {
    expect(SRC).not.toMatch(/\$\{\.\.\.householdIds\}/);
  });
});

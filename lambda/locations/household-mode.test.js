// HOUSEHOLD-MODE static-source guard (locations Lambda).
// Locations was GLOBAL pre-household (no created_by filter); this brings it into the
// household-scoped model per the 2026-05-20 "locations IN" decision. Asserts: householdScope
// import + householdIds, created_by = ANY(${householdIds}) on all locations reads/writes,
// the locations_with_path view scoped by id-subquery (view lacks created_by), featured-photo
// linkage switched uploaded_by -> household, INSERT now sets created_by = ${userId}, no spread.
// Static-source (L-072), DB-free.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

describe('locations Lambda — Household Mode scope widening', () => {
  it('imports householdScope + computes householdIds', () => {
    expect(SRC).toMatch(/import \{ householdScope \} from '\.\/household\.js'/);
    expect(SRC).toMatch(/const householdIds = householdScope\(userId\)/);
  });

  it('locations reads/writes scope by created_by = ANY(${householdIds})', () => {
    // GET-by-id + PUT id-resolve + PUT UPDATE + DELETE + LIST base + LIST path subquery + POST parent = 7
    const matches = SRC.match(/created_by = ANY\(\$\{householdIds\}\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(7);
  });

  it('locations_with_path view scoped via id-subquery (view has no created_by column)', () => {
    expect(SRC).toMatch(/locations_with_path[\s\S]*?id IN \(SELECT id FROM locations WHERE deleted_at IS NULL AND created_by = ANY\(\$\{householdIds\}\)\)/);
  });

  it('featured-photo linkage switched uploaded_by -> household (no uploaded_by = ${userId} remains)', () => {
    expect(SRC).not.toMatch(/uploaded_by = \$\{userId\}/);
    expect(SRC).toMatch(/uploaded_by = ANY\(\$\{householdIds\}\)/);
  });

  it('INSERT now binds created_by = ${userId} (was missing pre-household)', () => {
    const insIdx = SRC.indexOf('INSERT INTO locations');
    const block = SRC.slice(insIdx, insIdx + 400);
    expect(block).toMatch(/sort_order, description, created_by/);
    expect(block).toMatch(/\$\{userId\}/);
    expect(block).not.toMatch(/householdIds/);
  });

  it('no array spread (42P18 guard)', () => {
    expect(SRC).not.toMatch(/\$\{\.\.\.householdIds\}/);
  });
});

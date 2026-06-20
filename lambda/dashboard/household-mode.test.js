// HOUSEHOLD-MODE static-source guard (dashboard handlers).
// Informational builders compute householdIds and widen created_by to = ANY(${householdIds}).
// ACTIONABLE surfaces (queryWaterDue, queryHeadsUp) are CARETAKER-scoped (assignee_user_id with
// created_by fallback when unassigned) so a member's Today band shows their own plantings (V3-SCOPE-002)
// so a member's Today band / heads-up shows only their own plantings (V3-SCOPE-001). Per-user
// surfaces (user_stats, favorites, dismissals) stay user_id = ${userId}; dismissal INSERT stays
// per-user. Static-source (L-072), DB-free.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'handlers.js'), 'utf8');

describe('dashboard handlers — Household Mode scope widening', () => {
  it('imports householdScope from ../household.js (pure module, env-only)', () => {
    expect(SRC).toMatch(/import \{ householdScope \} from '\.\/household\.js'/);
  });

  it('handlers.js remains free of @neondatabase/serverless import (still pure)', () => {
    expect(SRC).not.toMatch(/from '@neondatabase\/serverless'/);
  });

  it('7 informational ownership-filtering builders each compute householdIds', () => {
    const matches = SRC.match(/const householdIds = householdScope\(userId\)/g) ?? [];
    expect(matches.length).toBe(7);
  });

  it('8 informational ownership filter sites stay widened to = ANY(${householdIds})', () => {
    const matches = SRC.match(/created_by = ANY\(\$\{householdIds\}\)/g) ?? [];
    expect(matches.length).toBe(8);
  });

  it('queryFavoriteCount stays per-user (user_id, no householdIds)', () => {
    const i = SRC.indexOf('export function queryFavoriteCount');
    const block = SRC.slice(i, SRC.indexOf('export function', i + 1));
    expect(block).toMatch(/user_id = \$\{userId\}/);
    expect(block).not.toMatch(/householdIds/);
  });

  it('queryUserStats stays per-user (user_id, no householdIds)', () => {
    const i = SRC.indexOf('export function queryUserStats');
    const block = SRC.slice(i, SRC.indexOf('export function', i + 1));
    expect(block).toMatch(/user_id = \$\{userId\}/);
    expect(block).not.toMatch(/householdIds/);
  });

  it('dismissal read-guards stay per-user (d.user_id = ${userId})', () => {
    expect(SRC).toMatch(/d\.user_id = \$\{userId\}/);
  });

  it('dismissal INSERT stays per-user (writes user_id = the requester)', () => {
    const i = SRC.indexOf('INSERT INTO inactive_project_dismissals');
    const block = SRC.slice(i, i + 300);
    expect(block).toMatch(/SELECT \$\{userId\}, id FROM owned/);
    expect(block).not.toMatch(/householdIds/);
  });

  it('dismiss handler project-existence check DOES widen (member can dismiss shared card)', () => {
    const i = SRC.indexOf('export function queryDismissInactive');
    const ownedIdx = SRC.indexOf('WITH owned AS', i);
    const block = SRC.slice(ownedIdx, ownedIdx + 250);
    expect(block).toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
  });

  it('V3-SCOPE-002: queryWaterDue is caretaker-scoped (assignee_user_id w/ created_by fallback, not household)', () => {
    const i = SRC.indexOf('export function queryWaterDue');
    const block = SRC.slice(i, SRC.indexOf('export function', i + 1));
    expect(block).toMatch(/pp\.assignee_user_id = \$\{userId\}/);
    expect(block).toMatch(/pp\.assignee_user_id IS NULL AND pp\.created_by = \$\{userId\}/);
    expect(block).not.toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
  });

  it('V3-SCOPE-002: queryHeadsUp both CTEs caretaker-scoped (assignee w/ created_by fallback, not household)', () => {
    const i = SRC.indexOf('export function queryHeadsUp');
    const block = SRC.slice(i, SRC.indexOf('export function', i + 1));
    const m = block.match(/pp\.assignee_user_id = \$\{userId\}/g) ?? [];
    expect(m.length).toBe(2);
    expect(block).not.toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
  });

  it('no array spread (42P18 guard)', () => {
    expect(SRC).not.toMatch(/\$\{\.\.\.householdIds\}/);
  });
});

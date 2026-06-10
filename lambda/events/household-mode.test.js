// HOUSEHOLD-MODE static-source guard (events Lambda) — SURGICAL widening.
// Only event ENTITY reads/writes widen. Achievement / XP / streak queries (per-user)
// MUST stay created_by = ${userId} / user_id = ${userId}. Static-source (L-072), DB-free.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

describe('events Lambda — Household Mode surgical widening', () => {
  it('imports householdScope + computes householdIds', () => {
    expect(SRC).toMatch(/import \{ householdScope \} from '\.\/household\.js'/);
    expect(SRC).toMatch(/const householdIds = householdScope\(userId\)/);
  });

  it('exactly 7 event-entity sites widened to pp.created_by = ANY(${householdIds})', () => {
    // UPDATE event_log guard + 3 event LIST/GET reads + Unit A bulk Quick Log batch
    // plant-resolution (2026-05-24) + HS-2 planting-scoped LIST read (2026-06-04, V3-NAV-001)
    // + DELETE /:id single-event-undo ownership pre-check (2026-06-10, V3-LOGMANY undo fix).
    // Each is an event-entity op, so household-widening is correct per the surgical-widening
    // invariant. Count was 4 pre-Unit-A, 5 post-Unit-A, 6 post-HS-2, 7 post-undo-fix (L-099 drift class).
    const matches = SRC.match(/pp\.created_by = ANY\(\$\{householdIds\}\)/g) ?? [];
    expect(matches.length).toBe(7);
  });

  it('achievement resolved-set query NOT widened (per-user isolation invariant)', () => {
    // The resolved-set CTE counts THIS user's resolved issues for the achievement
    // evaluator — must remain scoped to the requesting user.
    const resolveDayIdx = SRC.indexOf('AS resolve_day');
    expect(resolveDayIdx).toBeGreaterThan(-1);
    const block = SRC.slice(resolveDayIdx, resolveDayIdx + 400);
    expect(block).toMatch(/pp\.created_by = \$\{userId\}/);
    expect(block).not.toMatch(/householdIds/);
  });

  it('achievement event_counts query NOT widened (per-user isolation invariant)', () => {
    // The COUNT(*) FILTER block feeding type_events/today_events stays per-user.
    const teIdx = SRC.indexOf('AS type_events');
    expect(teIdx).toBeGreaterThan(-1);
    const block = SRC.slice(teIdx, teIdx + 400);
    expect(block).toMatch(/created_by = \$\{userId\} AND deleted_at IS NULL/);
    expect(block).not.toMatch(/householdIds/);
  });

  it('set_config audit-actor stays the real requesting user', () => {
    expect(SRC).toMatch(/set_config\('app\.actor_clerk_sub', \$\{userId\}, true\)/);
  });

  it('per-user surfaces (user_id) untouched', () => {
    // user_stats / xp_events / user_achievements / notification_subscriptions all key on user_id.
    expect(SRC).toMatch(/user_id = \$\{userId\}/);
  });

  it('no array spread (42P18 guard)', () => {
    expect(SRC).not.toMatch(/\$\{\.\.\.householdIds\}/);
  });
});

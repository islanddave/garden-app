// V1.2a-4 S6 (PROJ-RESCOPE) static-source regression guard for the kind-coalesce
// fix on the POST create path of lambda/projects/index.js.
//
// Blocker (PN1, audited 2026-05-20 vs dev HEAD 4be1e93): ProjectNew's "Not sure
// yet" default submits kind:null, and the POST INSERT bound `${body.kind ?? null}`,
// creating ALIVE plant_projects rows with kind=NULL. The s6-0a migration adds
// CHECK (kind IS NOT NULL OR deleted_at IS NOT NULL); once live, every such create
// would 500. Fix: coalesce a missing kind to 'campaign' server-side so the
// invariant holds for ALL callers (frontend + direct API), independent of the UI.
//
// Static-source pattern (L-072) — CI-runnable without a DB.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

describe('projects Lambda POST kind-coalesce (S6 / PN1 guard)', () => {
  it('declares effectiveKind coalescing a missing kind to a non-null default', () => {
    expect(SRC).toMatch(/const effectiveKind = body\.kind \?\? 'campaign';/);
  });

  it('the POST INSERT no longer binds a nullable kind directly (no kind=NULL alive rows)', () => {
    // Pre-fix shape `${body.kind ?? null},` (the INSERT bind) created kind=NULL rows.
    // UPDATE CASE branches use `${body.kind ?? null} ELSE` (no trailing comma) and are unaffected.
    expect(SRC.includes('${body.kind ?? null},')).toBe(false);
  });

  it('the INSERT INTO plant_projects binds effectiveKind for the kind column', () => {
    const i = SRC.indexOf('INSERT INTO public.container');
    expect(i).toBeGreaterThan(-1);
    expect(SRC.slice(i, i + 900)).toMatch(/\$\{effectiveKind\},/);
  });

  it('campaign is a member of the canonical ALLOWED_KINDS list', () => {
    expect(SRC).toMatch(/ALLOWED_KINDS = \['campaign', 'category', 'cultivar'\]/);
  });

  it('does not reintroduce the 42P18 type-indeterminate shape (L-086 cross-guard)', () => {
    expect(/\$\{[^}]*\}\s+IS\s+NOT\s+NULL/i.test(SRC)).toBe(false);
  });
});

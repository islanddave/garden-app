// garden-ux-events static-source guards (Inc 0 success-metric sink).
// Static-source pattern (L-072 fallback) — the handler is wrapped in Secrets Manager /
// Clerk verifyToken / Neon HTTP, so we assert the structural invariants of the source
// rather than execute end-to-end. Plus one executable check on the exported allowlist.
// Spec: success-metric-instrumentation-spec-V001-20260522.1620.md.

// NOTE: static-source only — do NOT import ./index.js. The handler imports
// @neondatabase/serverless / @clerk/backend (lambda-local node_modules, not at repo
// root), which the root vitest/vite resolver cannot resolve. Same convention as
// lambda/projects/admin-patch.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

describe('ux-events allowlist (static-source)', () => {
  // V4-PHOTOUPLOADINSTR-001 grew this from three to five. 'open_planting' had shipped in the CLIENT
  // on 2026-06-03 and was never listed here, so it recorded ZERO prod rows in 2.5 months; this exact
  // assertion was green throughout, because "exactly the three" describes the server in isolation
  // and the defect was a DISAGREEMENT. flowLockstep.test.js is the guard that can see it — this one
  // remains useful only as a pin on the literal set.
  it('declares exactly the five allowed flows in ALLOWED_FLOWS', () => {
    const m = SRC.match(/ALLOWED_FLOWS = new Set\(\[([^\]]*)\]\)/);
    expect(m, 'expected ALLOWED_FLOWS Set literal').toBeTruthy();
    const flows = m[1].match(/'[^']+'/g).map((s) => s.replace(/'/g, '')).sort();
    expect(flows).toEqual(['create_project', 'log_watering', 'open_planting', 'photo_upload', 'reach_planting']);
  });
});

describe('ux-events POST append (static-source guards)', () => {
  it('handles a POST branch', () => {
    expect(SRC).toMatch(/if \(method === 'POST'\)/);
  });

  it('rejects unknown flow_id (400) via the allowlist', () => {
    expect(SRC).toMatch(/ALLOWED_FLOWS\.has\(flowId\)/);
    const m = SRC.match(/!ALLOWED_FLOWS\.has\(flowId\)[\s\S]{0,120}/);
    expect(m?.[0]).toMatch(/400/);
  });

  it('takes clerk_sub from the verified JWT (userId), NEVER from the body', () => {
    // The INSERT binds ${userId}; the body is parsed but clerk_sub is not read from it.
    expect(SRC).toMatch(/INSERT INTO ux_events[\s\S]{0,400}\$\{userId\}/);
    expect(SRC).not.toMatch(/body\.clerk_sub/);
  });

  it('requires session_id', () => {
    expect(SRC).toMatch(/session_id is required/);
  });

  it('explicitly casts the type-indeterminate params (L-086 guard: ::timestamptz, ::jsonb)', () => {
    expect(SRC).toMatch(/\$\{clientTs\}::timestamptz/);
    expect(SRC).toMatch(/\$\{metaJson\}::jsonb/);
  });
});

describe('ux-events GET admin aggregates (static-source guards)', () => {
  it('reads ADMIN_CLERK_SUBS from process.env', () => {
    expect(SRC).toMatch(/process\.env\.ADMIN_CLERK_SUBS/);
  });

  it('fails closed when ADMIN_CLERK_SUBS is empty (403 Admin route not configured)', () => {
    const m = SRC.match(/allow\.length === 0[\s\S]{0,120}/);
    expect(m?.[0]).toMatch(/403/);
    expect(m?.[0]).toMatch(/Admin route not configured/);
  });

  it('rejects bare (non-admin) GET and non-allowlisted callers (403)', () => {
    const m = SRC.match(/!adminMode \|\| !allow\.includes\(userId\)[\s\S]{0,80}/);
    expect(m?.[0]).toMatch(/403/);
  });

  it('M2 derives capture-events/week from EXISTING tables (no new write path)', () => {
    for (const tbl of ['event_log', 'public.garden_node', 'public.container']) {
      expect(SRC).toMatch(new RegExp(`SELECT created_at FROM ${tbl}`));
    }
    expect(SRC).toMatch(/date_trunc\('week', created_at\)/);
  });

  it('M3 is a placeholder until the Inc-3 tasks table exists, and draws the 40% canary', () => {
    expect(SRC).toMatch(/to_regclass\('public\.tasks'\)/);
    expect(SRC).toMatch(/canary_threshold: 0\.40/);
  });

  it('M3 tolerates tasks-table shape drift (try/catch degrades, never 500s the panel)', () => {
    // A pre-Inc-3 tasks table (present but missing agent_proposed/accepted_at) must NOT
    // 500 the admin GET. The tasks query is wrapped so it degrades to not-available.
    const m3start = SRC.indexOf('let m3 =');
    const block = SRC.slice(m3start, SRC.indexOf('return resp(200', m3start));
    expect(block).toMatch(/try \{/);
    expect(block).toMatch(/\} catch \{/);
    expect(block).toMatch(/missing agent-proposal columns/);
  });
});

describe('ux-events CORS discipline', () => {
  it('keeps CORS={} (Function URL config is the sole CORS source — L-097)', () => {
    expect(SRC).toMatch(/const CORS = \{\};/);
  });
});

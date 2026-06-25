import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Static-source guard (crucible D-SCOPE): every visibility-scoped read of public.tag must carry the ONE
// canonical predicate (private→own, shared→household, system→all). A drift here is a cross-user leak.
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'index.js'), 'utf8');

describe('tags lambda visibility predicate is canonical and un-bypassed', () => {
  it('contains the canonical 3-branch predicate', () => {
    expect(src).toMatch(/visibility = 'private' AND owner_id = \$\{userId\}/);
    expect(src).toMatch(/visibility = 'shared' AND owner_id = ANY\(\$\{household\}\)/);
    expect(src).toMatch(/OR (?:t\.)?owner_id = 'system'/);
  });

  it('every scoped list read of tag uses the system branch (GET /api/tags + GET /api/entity-tags direct)', () => {
    const systemBranches = (src.match(/owner_id = 'system' \)/g) || []).length;
    expect(systemBranches).toBeGreaterThanOrEqual(2);
  });

  it('the planting projection is restricted to derived tags (system/shared by construction)', () => {
    expect(src).toMatch(/t\.source = 'derived'\s*\n\s*WHERE gn\.id/);
  });

  it('derived tags cannot be hand-attached (403 guard present)', () => {
    expect(src).toMatch(/derived tags are system-managed and cannot be attached/);
  });

  it('admin gate guards the bulk derive endpoint', () => {
    expect(src).toMatch(/if \(!isAdmin\(userId, process\.env\)\) return resp\(403/);
  });
});

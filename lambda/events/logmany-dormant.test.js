// BUG-LOGMANYSTATUS-001 — the Log Many batch scope SELECT must keep NULL-status plantings (the
// `IS NULL OR` arm). plants.status is nullable and prod holds NULL rows; no integration fixture has
// one, so this file is the only guard of that arm. The rest of the scope rule is proven elsewhere:
// the excluded triple and the `rooting` control in tests/integration/logmany-dormant.int.test.js,
// soft-deleted and archived picks in tests/integration/logmany-scopeids.int.test.js, and the
// predicate text (both events/index.js copies) in lambda/live-planting-predicate-sync.test.js.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — the commentary above this fix mentions
// both `dormant` and the ('failed','ended','dormant') triple by name, so every assertion below
// would find its own prose and pass. Assertions run against decommented source.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// The batch scope SELECT, delimited by its container join and its ORDER BY. The harvest-readiness
// SELECT carries a byte-identical predicate, so a whole-file match would pass with the scope
// unfiltered. The `AND pp.deleted_at IS NULL` tail keeps the FROM needle unique: the event_log
// INSERT below carries the same LEFT JOIN without it.
const FROM = 'LEFT JOIN public.container pp ON pp.id = p.container_id AND pp.deleted_at IS NULL';
const ORDER = 'ORDER BY p.display_name, p.id';
const fromIdx = SRC.indexOf(FROM);
const orderIdx = SRC.indexOf(ORDER, fromIdx);
const SCOPE_SELECT = fromIdx > -1 && orderIdx > fromIdx ? SRC.slice(fromIdx, orderIdx) : '';

describe('events Lambda — Log Many scope keeps NULL-status plantings', () => {
  it('the batch scope SELECT is still locatable (the slice these assertions depend on)', () => {
    expect(fromIdx).toBeGreaterThan(-1);
    expect(orderIdx).toBeGreaterThan(fromIdx);
    expect(SCOPE_SELECT).toMatch(/AND NOT \(p\.id = ANY\(\$\{excludeIds\}\)\)/);
  });

  it('is NULL-safe — a NULL status must not be swallowed by three-valued logic', () => {
    // `p.status NOT IN (...)` alone evaluates to NULL for a NULL status, which SQL treats as false:
    // every status-less planting would silently vanish from Log Many. `status` is nullable and
    // every other care query in the codebase guards it the same way.
    expect(SCOPE_SELECT).toMatch(/p\.status IS NULL OR p\.status NOT IN/);
  });
});

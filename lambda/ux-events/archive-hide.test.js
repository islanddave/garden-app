// V4-ARCHIVEHIDE-001 (L7) — the M2 capture-per-week metric must not count ARCHIVED rows.
//
// The weakest of the six closures and the file says so out loud: the route is admin-gated (403), so
// it is not a "default view" in the user-facing sense, and M2 measures capture ACTIVITY, which
// archiving later does not undo. It is closed because the ticket says "must not be loaded at all"
// and the archived rows are genuinely being read. These assertions pin the SHAPE so a reversal is a
// deliberate edit here, not a silent one.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

describe('ux-events Lambda — M2 excludes archived plantings and projects (L7)', () => {
  it('both garden_node and container arms of the union filter archived_at', () => {
    expect(SRC).toMatch(/UNION ALL SELECT created_at FROM public\.garden_node WHERE archived_at IS NULL/);
    expect(SRC).toMatch(/UNION ALL SELECT created_at FROM public\.container WHERE archived_at IS NULL/);
  });

  // event_log has no archived_at column at all — the axis lives only on plants/plant_projects. An
  // edit that "makes the three arms consistent" by adding it here ships a 42703 to an admin panel.
  it('does not put archived_at on the event_log arm — the column does not exist there', () => {
    expect(SRC).toMatch(/SELECT created_at FROM event_log\s*\n/);
    expect(SRC).not.toMatch(/FROM event_log WHERE archived_at/);
  });

  it('M1 and M3 are untouched', () => {
    expect(SRC).toMatch(/FROM ux_events\s*\n\s*WHERE tap_count IS NOT NULL/);
    expect(SRC).toMatch(/to_regclass\('public\.tasks'\)/);
  });
});

// V4-HARVWEIGHTEST-001 — the plants-PUT hook that re-files calibration samples when a planting is
// re-identified.
//
// Static-source assertions, same rationale as variety-clear.test.js and select-columns.test.js:
// lambda/plants/index.js imports @neondatabase/serverless + @clerk/backend + @aws-sdk/* at module
// load, so there is no runtime-handler seam without a handlers.js split (out of scope). Every
// assertion below corresponds to a way the hook silently stops working.
//
// The bug this guards: cultivar_weight_sample.cultivar_id is a COPY of the source planting's
// cultivar, taken at capture time, with nothing that maintains it. "Cherry Rescue 1" (notes:
// 'Formerly "Beefsteak"') had two cherry tomatoes, 28 g and 16 g, standing in the corpus as the only
// evidence about a 350 g beefsteak, and the planting named "Blackberry" had two drupelet weighings
// filed under Aster — promoted at 'high' confidence and acked for propagation.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — the decomment idiom is copied verbatim
// from variety-clear.test.js so a future edit that deletes the call and leaves `// was: ...` behind
// cannot find its own epitaph and pass.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const RAW = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
const SRC = decomment(RAW);

describe('plants Lambda PUT — weight-sample re-attribution hook', () => {
  it('calls reattribute_plant_weight_samples with the planting id and the actor', () => {
    expect(
      SRC.includes('public.reattribute_plant_weight_samples(${plantId}::uuid, ${userId})'),
      're-attribution call missing or its arguments changed',
    ).toBe(true);
  });

  // Gated on the PRESENCE of variety_id, not on an observed old->new transition. Both live
  // re-identifications left ZERO audit_events rows (audit coverage is plant_varieties only), so a
  // transition-based hook would have missed both. The function's own mismatch predicate is the
  // change detector and is a no-op when the corpus already agrees.
  it('is gated on the hasVariety presence-sentinel', () => {
    const i = SRC.indexOf('reattribute_plant_weight_samples');
    expect(i).toBeGreaterThan(-1);
    expect(SRC.slice(Math.max(0, i - 400), i)).toMatch(/if \(hasVariety\) \{/);
  });

  // A correction to a satellite table must never roll back the planting edit the user asked for.
  // Same posture as the events Lambda's auto-capture hook, which logs and continues.
  it('runs AFTER the transaction and cannot fail the save', () => {
    const iTx = SRC.indexOf('await sql.transaction(_stmts)');
    const iHook = SRC.indexOf('reattribute_plant_weight_samples');
    expect(iTx).toBeGreaterThan(-1);
    expect(iHook).toBeGreaterThan(iTx);
    // Not pushed into the transaction statement array.
    expect(SRC).not.toMatch(/_stmts\.push\([\s\S]{0,200}reattribute_plant_weight_samples/);
    // Wrapped, and the catch does not rethrow.
    const block = SRC.slice(iHook - 200, iHook + 400);
    expect(block).toMatch(/try \{/);
    expect(block).toMatch(/catch \(e\)[\s\S]{0,120}console\.warn/);
    expect(block).not.toMatch(/catch \(e\)[\s\S]{0,120}throw/);
  });

  // The hook is the only thing in this handler that may touch the weight tables. If a future edit
  // reaches for harvest_log here, the stored-estimate re-derivation has escaped the ratchet's
  // total-move guard, which is the one thing standing between Dave and a season total that moves
  // under him unannounced.
  it('does not re-derive stored harvest weights from the plants handler', () => {
    expect(SRC).not.toMatch(/UPDATE\s+public\.harvest_log/i);
    expect(SRC).not.toMatch(/resolve_harvest_weight/);
  });
});

#!/usr/bin/env node
// Which live candidates carrying NO timing prose and NO days-to-maturity are told "too late",
// and on what dates. Runs the real bucketize over a full dump of v_sow_candidates from prod.
//
// The claim under test: a card with no prose and no dtm still reads too_late, which is the same
// unfounded verdict BUG-SOWPROSEUNREAD-001 fixed for unreadable prose, in a second costume. A verdict
// that is wrong in MARCH is a fallthrough wearing a verdict — so sweep the season rather than probe
// one date, exactly as that fix's own guard does.
// Usage: node scripts/measure-noprose-toolate.mjs <candidates.json>
import { readFileSync } from 'node:fs';
import { bucketize } from '../src/lib/sowEngine.js';

const rows = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const bare = rows.filter((r) => !r.direct_sow_timing
  && r.days_to_maturity_min == null && r.days_to_maturity_max == null);

console.log(`candidates: ${rows.length}   no prose AND no dtm: ${bare.length}\n`);
for (const r of bare) {
  console.log(`• ${r.variety_name}  [${r.item_name}]`);
  console.log(`  crop_type=${r.crop_type_slug}  season=${r.sow_season}  method=${r.start_method}`
            + `  lifecycle=${r.lifecycle}  grown_as=${r.grown_as}  notes=${r.sow_notes ? 'yes' : 'none'}`);
}

const DAYS = ['2026-03-01', '2026-04-15', '2026-05-20', '2026-07-10', '2026-09-02', '2026-11-15'];
console.log('\nbucket by date (the whole no-prose/no-dtm set):');
for (const day of DAYS) {
  const b = bucketize(bare, day);
  const hit = Object.entries(b).filter(([, v]) => v.length).map(([k, v]) => `${k}=${v.length}`);
  console.log(`  ${day}  ${hit.join('  ') || '(none)'}`);
}

console.log('\nper-variety verdict on 2026-03-01 — the decisive date, when nothing can be "too late":');
for (const r of bare) {
  const b = bucketize([r], '2026-03-01');
  const which = Object.entries(b).find(([, v]) => v.length);
  const entry = which?.[1][0];
  console.log(`  ${which?.[0] ?? 'DROPPED'}  ${r.variety_name} — ${entry?.windowLabel ?? 'no label'}`);
}

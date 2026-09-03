#!/usr/bin/env node
// BUG-SOWHARDYANCHOR-001 — what the anchor move actually does to live cards.
// Diffs bucket + window label per candidate between the CURRENT engine and a baseline copy, so the
// change is judged on real movement rather than on the arithmetic. Anchors, not assertions.
// Usage: node scripts/measure-hardy-anchor-shift.mjs <candidates.json> <baselineModule>
import { readFileSync } from 'node:fs';

const now = await import('../src/lib/sowEngine.js');
const base = await import(process.argv[3]);
const rows = JSON.parse(readFileSync(process.argv[2], 'utf8'));

const DAYS = ['2026-03-01', '2026-07-10', '2026-08-15', '2026-09-03', '2026-10-01'];
const hardy = rows.filter((r) => now.FALL_HARDY_CROPS.has(r.crop_type_slug));
console.log(`candidates ${rows.length} | fall-hardy slugs ${hardy.length}\n`);

const one = (mod, r, day) => {
  const b = mod.bucketize([r], day);
  const hit = Object.entries(b).find(([, v]) => v.length);
  return hit ? { bucket: hit[0], label: hit[1][0].windowLabel ?? '' } : { bucket: 'DROPPED', label: '' };
};

let moved = 0, same = 0;
const seen = new Set();
for (const day of DAYS) {
  const changes = [];
  for (const r of rows) {
    const a = one(base, r, day);
    const b = one(now, r, day);
    if (a.bucket === b.bucket && a.label === b.label) { same++; continue; }
    moved++;
    changes.push(`    ${r.variety_name} [${r.crop_type_slug}]  ${a.bucket}"${a.label}" -> ${b.bucket}"${b.label}"`);
    seen.add(r.variety_name);
  }
  console.log(`${day}: ${changes.length} changed`);
  changes.slice(0, 12).forEach((c) => console.log(c));
  if (changes.length > 12) console.log(`    ...and ${changes.length - 12} more`);
}
console.log(`\ncell-comparisons moved ${moved}, unchanged ${same}; distinct varieties touched ${seen.size}`);
const nonHardy = [...seen].filter((v) => {
  const r = rows.find((x) => x.variety_name === v);
  return !now.FALL_HARDY_CROPS.has(r.crop_type_slug);
});
console.log(`NON-hardy varieties touched (MUST be 0): ${nonHardy.length}`, nonHardy.slice(0, 8));

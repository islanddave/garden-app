// Runs the REAL splitClauses/classifyClause over a JSON dump of live prod sow prose.
// Never re-implement the classifier here — re-implementing measures this file's reading of it.
// Usage: node scripts/measure-unparsed-sow-clauses.mjs <dump.json>
import { readFileSync } from 'node:fs';
import { splitClauses, classifyClause } from '../src/lib/sowEngine.js';

const rows = JSON.parse(readFileSync(process.argv[2], 'utf8')).filter((r) => r.direct_sow_timing);

let totalClauses = 0;
const allLost = [];   // every clause unclassified — the card shows a verdict from nothing
const someLost = [];  // keeps at least one class, silently drops the rest

for (const r of rows) {
  const clauses = splitClauses(r.direct_sow_timing);
  const marked = clauses.map((c) => ({ clause: c, cls: classifyClause(c).cls }));
  totalClauses += marked.length;
  const lost = marked.filter((m) => m.cls === null);
  if (!lost.length) continue;
  const rec = {
    variety: r.variety_name,
    item: r.item_name,
    prose: r.direct_sow_timing,
    lost: lost.map((m) => m.clause),
    kept: marked.filter((m) => m.cls).map((m) => `${m.cls}: ${m.clause}`),
  };
  (lost.length === marked.length ? allLost : someLost).push(rec);
}

const uniq = (a) => [...new Set(a)];
console.log(`prose rows: ${rows.length}   clauses: ${totalClauses}`);
console.log(`clauses unclassified: ${[...allLost, ...someLost].reduce((n, r) => n + r.lost.length, 0)}`);
console.log(`varieties losing EVERY clause: ${allLost.length} (${uniq(allLost.map((r) => r.variety)).length} distinct)`);
console.log(`varieties losing SOME clause:  ${someLost.length} (${uniq(someLost.map((r) => r.variety)).length} distinct)`);

for (const [label, set] of [['=== TOTAL LOSS (no window at all) ===', allLost],
                            ['=== PARTIAL LOSS (keeps some) ===', someLost]]) {
  console.log(`\n${label}`);
  for (const r of set) {
    console.log(`\n• ${r.variety}  [${r.item}]`);
    console.log(`  prose: ${r.prose}`);
    r.lost.forEach((c) => console.log(`  LOST : ${c}`));
    r.kept.forEach((c) => console.log(`  kept : ${c}`));
  }
}

// reconcile-cultivar-facets.mjs — L-239 drift-heal. Bulk/direct-Neon cultivar inserts bypass the
// varieties-Lambda post-commit applyDerive hook, so they land UNFACETED. This reconciler re-derives
// every live cultivar's system tags (idempotent: revive-or-insert + soft-delete stale derived links).
// Run on demand or from a scheduled task.  Usage: DATABASE_URL=<neon-url> node scripts/reconcile-cultivar-facets.mjs
import { neon } from '@neondatabase/serverless';
import { applyDerive } from '../lambda/tags/crop-derive.js';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(1); }
const res = await applyDerive(neon(url), null);
console.log(JSON.stringify({ cultivars:res.cultivars, tags_upserted:res.tags_upserted, links_added:res.links_added, links_removed:res.links_removed, failures:res.failures.length }));
if (res.failures.length) { console.error('FAILURES:', JSON.stringify(res.failures.slice(0,10))); process.exit(2); }

// EPHEMERAL prod backfill for V4-TAGSUB-001 — materializes derived type:/lifecycle: tags for all existing
// cultivars (the inline path covers new/edited varieties going forward). Idempotent, additive, COW-proven.
import { neon } from '@neondatabase/serverless';
import { writeFileSync } from 'node:fs';
import { applyDerive } from '../lambda/tags/crop-derive.js';
const sql = neon(process.env.PROD_URL);
try {
  const totals = await applyDerive(sql, null);
  const tagCount = (await sql`SELECT count(*)::int n FROM tag WHERE source='derived' AND deleted_at IS NULL`)[0].n;
  const linkCount = (await sql`SELECT count(*)::int n FROM entity_tag et JOIN tag t ON t.id=et.tag_id WHERE t.source='derived' AND et.deleted_at IS NULL`)[0].n;
  const byFacet = await sql`SELECT facet, count(*)::int n FROM tag WHERE source='derived' AND deleted_at IS NULL GROUP BY facet ORDER BY facet`;
  const out = { ok: true, totals, derived_tags: tagCount, derived_links: linkCount, by_facet: byFacet };
  writeFileSync('/tmp/backfill_result.json', JSON.stringify(out, null, 2));
  console.log('DONE', JSON.stringify(out));
} catch (e) {
  writeFileSync('/tmp/backfill_result.json', JSON.stringify({ ok: false, error: e?.message ?? String(e) }));
  console.error('BACKFILL ERROR', e?.message ?? e);
  process.exit(1);
}

// EPHEMERAL COW dry-run for V4-TAGSUB-001 — runs applyDerive + the index.js revive-or-insert CTEs against a
// throwaway Neon branch. Deleted after use. Not committed.
import { neon } from '@neondatabase/serverless';
import { applyDerive, computeDerivedTags } from '../lambda/tags/crop-derive.js';

const sql = neon(process.env.COW_URL);
let fails = 0;
function check(name, cond, extra='') { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`); if (!cond) fails++; }

const liveLinks = (cid) => sql`SELECT t.facet, t.slug FROM entity_tag et JOIN tag t ON t.id=et.tag_id
  WHERE et.entity_type='cultivar' AND et.entity_id=${cid} AND et.deleted_at IS NULL AND t.source='derived' ORDER BY t.facet`;
const liveTagCount = (facet, slug, owner) => sql`SELECT count(*)::int n FROM tag WHERE facet=${facet} AND slug=${slug} AND owner_id=${owner} AND deleted_at IS NULL`;
const anyTagCount = (facet, slug, owner) => sql`SELECT count(*)::int n FROM tag WHERE facet=${facet} AND slug=${slug} AND owner_id=${owner}`;

const [cv] = await sql`SELECT id, crop_type_slug, lifecycle FROM plant_varieties WHERE crop_type_slug IS NOT NULL AND deleted_at IS NULL LIMIT 1`;
console.log('test cultivar', cv.id, 'crop=', cv.crop_type_slug, 'lifecycle=', cv.lifecycle);

// 1. derive for one cultivar -> type + lifecycle links materialize
await applyDerive(sql, cv.id);
let l = await liveLinks(cv.id);
check('1 derive: type link present', l.some(r => r.facet === 'type' && r.slug === cv.crop_type_slug), JSON.stringify(l));
check('1 derive: lifecycle link present', l.some(r => r.facet === 'lifecycle'));
const expected = computeDerivedTags(cv, Object.fromEntries((await sql`SELECT slug,display_name,default_lifecycle FROM crop_types`).map(c => [c.slug, c])));
check('1 derive: live set == computeDerivedTags set (no extras)',
  l.length === expected.length && expected.every(e => l.some(r => r.facet===e.facet && r.slug===e.slug)), `${l.length} vs ${expected.length}`);

// 2. idempotent re-run -> link count stable, no duplicate tag rows
await applyDerive(sql, cv.id);
let l2 = await liveLinks(cv.id);
check('2 idempotent: link count unchanged', l2.length === l.length, `${l.length}->${l2.length}`);
let [{ n: typeTagDup }] = await liveTagCount('type', cv.crop_type_slug, 'system');
check('2 idempotent: exactly one live type tag', typeTagDup === 1, `n=${typeTagDup}`);

// 3. crop_type change -> reconcile soft-deletes the stale type link, adds the new one (use 'basil' as the alt)
const alt = cv.crop_type_slug === 'basil' ? 'beet' : 'basil';
await sql`UPDATE plant_varieties SET crop_type_slug=${alt} WHERE id=${cv.id}`;
await applyDerive(sql, cv.id);
let l3 = await liveLinks(cv.id);
check('3 reconcile: new type slug present', l3.some(r => r.facet==='type' && r.slug===alt), JSON.stringify(l3));
check('3 reconcile: old type slug gone (soft-deleted)', !l3.some(r => r.facet==='type' && r.slug===cv.crop_type_slug));

// 4. flip back A->B->A : old type tag row was soft-deleted-link only; tag rows persist; assert exactly ONE live link, no dup link rows
await sql`UPDATE plant_varieties SET crop_type_slug=${cv.crop_type_slug} WHERE id=${cv.id}`;
await applyDerive(sql, cv.id);
let dupLinks = await sql`SELECT count(*)::int n FROM entity_tag et JOIN tag t ON t.id=et.tag_id
  WHERE et.entity_type='cultivar' AND et.entity_id=${cv.id} AND et.deleted_at IS NULL AND t.facet='type'`;
check('4 flip-back A->B->A: exactly one live type link (revive, no dup)', dupLinks[0].n === 1, `n=${dupLinks[0].n}`);

// 5. bulk applyDerive over ALL cultivars, then idempotent re-run -> total live derived links stable
const bulk1 = await applyDerive(sql, null);
const total1 = (await sql`SELECT count(*)::int n FROM entity_tag et JOIN tag t ON t.id=et.tag_id WHERE t.source='derived' AND et.deleted_at IS NULL`)[0].n;
const bulk2 = await applyDerive(sql, null);
const total2 = (await sql`SELECT count(*)::int n FROM entity_tag et JOIN tag t ON t.id=et.tag_id WHERE t.source='derived' AND et.deleted_at IS NULL`)[0].n;
check('5 bulk idempotent: total live derived links stable across two runs', total1 === total2, `${total1} vs ${total2}; failures=${bulk2.failures.length}`);
check('5 bulk: no per-cultivar failures', bulk2.failures.length === 0, JSON.stringify(bulk2.failures.slice(0,3)));
console.log(`   bulk run1: ${bulk1.cultivars} cultivars, ${total1} live derived links`);

// 6. revive-or-insert for USER tag-create CTE (D-SQL2): create, soft-delete, re-create -> same row revived, no live dup
const OWNER = 'user_cow_test';
async function createUserTag(facet, slug, label) {
  return sql`
    WITH live AS (SELECT id,'live'::text _o FROM tag WHERE facet=${facet} AND slug=${slug} AND owner_id=${OWNER} AND deleted_at IS NULL),
    revived AS (UPDATE tag SET deleted_at=NULL, label=${label}, updated_at=now()
       WHERE id=(SELECT id FROM tag WHERE facet=${facet} AND slug=${slug} AND owner_id=${OWNER} AND deleted_at IS NOT NULL ORDER BY created_at LIMIT 1) AND NOT EXISTS(SELECT 1 FROM live)
       RETURNING id,'revived'::text _o),
    inserted AS (INSERT INTO tag (facet,label,slug,source,owner_id,visibility,created_by)
       SELECT ${facet},${label},${slug},'user',${OWNER},'shared',${OWNER}
       WHERE NOT EXISTS(SELECT 1 FROM live) AND NOT EXISTS(SELECT 1 FROM revived) RETURNING id,'inserted'::text _o)
    SELECT * FROM live UNION ALL SELECT * FROM revived UNION ALL SELECT * FROM inserted`;
}
const c1 = await createUserTag('group', 'cow-houseplants', 'COW Houseplants');
check('6 user create: inserted on first call', c1[0]._o === 'inserted');
const c2 = await createUserTag('group', 'cow-houseplants', 'COW Houseplants');
check('6 user create: idempotent (live) on second call, same id', c2[0]._o === 'live' && c2[0].id === c1[0].id);
await sql`UPDATE tag SET deleted_at=now() WHERE id=${c1[0].id}`;
const c3 = await createUserTag('group', 'cow-houseplants', 'COW Houseplants');
check('6 user create: revived after soft-delete (same id, not a dup)', c3[0]._o === 'revived' && c3[0].id === c1[0].id, `_o=${c3[0]._o}`);
const [{ n: liveDup }] = await liveTagCount('group', 'cow-houseplants', OWNER);
check('6 user create: exactly one live row after revive', liveDup === 1, `n=${liveDup}`);

console.log(fails === 0 ? '\nALL COW CHECKS PASSED' : `\n${fails} COW CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);

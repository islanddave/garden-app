import { neon } from '@neondatabase/serverless';
import { applyDerive } from '../tags/crop-derive.js';
const sql = neon(process.env.COW_URL);
let fails = 0;
const check = (n, c, e='') => { console.log(`${c?'PASS':'FAIL'}  ${n}${e?' :: '+e:''}`); if(!c) fails++; };

// 5-lite. per-cultivar idempotency at small scale (5 distinct cultivars), proves bulk loop semantics w/o the 176-row HTTP timeout
const cvs = await sql`SELECT id, crop_type_slug, lifecycle FROM plant_varieties WHERE crop_type_slug IS NOT NULL AND deleted_at IS NULL LIMIT 5`;
for (const cv of cvs) { await applyDerive(sql, cv.id); }
const cnt = async () => (await sql`SELECT count(*)::int n FROM entity_tag et JOIN tag t ON t.id=et.tag_id
  WHERE t.source='derived' AND et.deleted_at IS NULL AND et.entity_id = ANY(${cvs.map(c=>c.id)}::uuid[])`)[0].n;
const a = await cnt();
for (const cv of cvs) { await applyDerive(sql, cv.id); }
const b = await cnt();
check('5-lite 5-cultivar idempotency: derived link count stable across reruns', a === b && a > 0, `${a} vs ${b}`);

// 6. user-tag create revive-or-insert (D-SQL2)
const OWNER='user_cow_test';
const create=(facet,slug,label)=>sql`
  WITH live AS (SELECT id,'live'::text _o FROM tag WHERE facet=${facet} AND slug=${slug} AND owner_id=${OWNER} AND deleted_at IS NULL),
  revived AS (UPDATE tag SET deleted_at=NULL,label=${label},updated_at=now()
     WHERE id=(SELECT id FROM tag WHERE facet=${facet} AND slug=${slug} AND owner_id=${OWNER} AND deleted_at IS NOT NULL ORDER BY created_at LIMIT 1) AND NOT EXISTS(SELECT 1 FROM live) RETURNING id,'revived'::text _o),
  inserted AS (INSERT INTO tag (facet,label,slug,source,owner_id,visibility,created_by)
     SELECT ${facet},${label},${slug},'user',${OWNER},'shared',${OWNER} WHERE NOT EXISTS(SELECT 1 FROM live) AND NOT EXISTS(SELECT 1 FROM revived) RETURNING id,'inserted'::text _o)
  SELECT * FROM live UNION ALL SELECT * FROM revived UNION ALL SELECT * FROM inserted`;
const c1=await create('group','cow-houseplants','COW Houseplants');
check('6 user create: inserted first time', c1[0]._o==='inserted');
const c2=await create('group','cow-houseplants','COW Houseplants');
check('6 user create: idempotent live, same id', c2[0]._o==='live' && c2[0].id===c1[0].id);
await sql`UPDATE tag SET deleted_at=now() WHERE id=${c1[0].id}`;
const c3=await create('group','cow-houseplants','COW Houseplants');
check('6 user create: revived after soft-delete, same id (no dup)', c3[0]._o==='revived' && c3[0].id===c1[0].id, `_o=${c3[0]._o}`);
const dup=(await sql`SELECT count(*)::int n FROM tag WHERE facet='group' AND slug='cow-houseplants' AND owner_id=${OWNER} AND deleted_at IS NULL`)[0].n;
check('6 user create: exactly one live row after revive', dup===1, `n=${dup}`);

console.log(fails===0?'\nALL COW CHECKS (5-lite,6) PASSED':`\n${fails} FAILED`);
process.exit(fails===0?0:1);

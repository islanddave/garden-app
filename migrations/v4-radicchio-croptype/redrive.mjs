// V4-RADICCHIO-001 post-SQL step: re-derive the facet tags for the repointed cultivar so the
// system-owned type: tag follows crop_type_slug (endive -> radicchio). Run AFTER 0a-data.sql.
//   DATABASE_URL=<neon-url> node migrations/v4-radicchio-croptype/redrive.mjs
import { neon } from '@neondatabase/serverless';
import { applyDerive } from '../../lambda/varieties/crop-derive.js';

const CULTIVAR_ID = '0609afc2-51ea-4045-858b-fe28060e2f20';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(1); }
const sql = neon(url);

const [cv] = await sql`SELECT name, crop_type_slug FROM plant_varieties WHERE id = ${CULTIVAR_ID}`;
if (!cv) { console.error('cultivar not found'); process.exit(1); }
if (cv.crop_type_slug !== 'radicchio') { console.error(`expected crop_type_slug=radicchio, got ${cv.crop_type_slug} — apply 0a-data.sql first`); process.exit(1); }

console.log(JSON.stringify(await applyDerive(sql, CULTIVAR_ID)));
console.log(JSON.stringify(await sql`SELECT t.facet, t.slug, t.source, et.deleted_at
  FROM entity_tag et JOIN tag t ON t.id = et.tag_id WHERE et.entity_id = ${CULTIVAR_ID}`));

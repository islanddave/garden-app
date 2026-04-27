import { queryAs } from '../shared/db.mjs';
import { requireAuth, AuthError, ok, created, noContent, err, corsPreflight } from '../shared/auth.mjs';

const XP_BY_TYPE = {watering:10,observation:15,pruning:20,fertilizing:20,transplant:25,harvest:30,first_harvest:30};
const DEFAULT_XP = 10;
const PHOTO_BONUS_XP = 5;
const MEM_COL_MAP = {
  watering:'last_watered_at',fertilizing:'last_fertilized_at',
  pruning:'last_pruned_at',observation:'last_observed_at',
  harvest:'last_harvested_at',first_harvest:'last_harvested_at',
};
const LEVEL_XP = [0,100,250,500,1000,2000,4000,7500,15000];
const levelFromXp = xp => LEVEL_XP.reduce((lv,thresh,i) => xp >= thresh ? i : lv, 0);

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return corsPreflight();
  const method = event.requestContext?.http?.method;
  const pathParts = (event.rawPath||'').split('/').filter(Boolean);
  const id = pathParts[2] || null;
  const qs = event.queryStringParameters || {};

  try {
    const userId = await requireAuth(event);

    // GET /api/events?project_id=x
    if (method === 'GET' && !id) {
      const {project_id} = qs;
      if (!project_id) return err(400,'project_id required');
      const {rows} = await queryAs(userId,
        `SELECT * FROM event_log WHERE project_id=$1 AND deleted_at IS NULL ORDER BY event_date DESC, created_at DESC`,
        [project_id]);
      return ok(rows);
    }

    // GET /api/events/:id
    if (method === 'GET' && id) {
      const {rows} = await queryAs(userId,
        `SELECT * FROM event_log WHERE id=$1 AND deleted_at IS NULL`, [id]);
      if (!rows.length) return err(404,'Event not found');
      return ok(rows[0]);
    }

    // POST /api/events — creates event + side effects, returns { eventId, stats }
    if (method === 'POST') {
      const {project_id,plant_id,event_type,event_date,title,notes,private_notes,quantity,is_public,has_photo} = JSON.parse(event.body||'{}');
      if (!project_id||!event_type||!event_date) return err(400,'project_id, event_type, event_date required');

      const eventDateIso = new Date(event_date+'T12:00:00').toISOString();
      const xpBase = XP_BY_TYPE[event_type] ?? DEFAULT_XP;
      const xpEarned = xpBase + (has_photo ? PHOTO_BONUS_XP : 0);

      const {rows:[ev]} = await queryAs(userId,
        `INSERT INTO event_log (project_id,plant_id,event_type,event_date,title,notes,private_notes,quantity,is_public,logged_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [project_id,plant_id||null,event_type,eventDateIso,title||null,notes||null,private_notes||null,quantity||null,is_public!==false,userId]);

      const memCol = MEM_COL_MAP[event_type];
      if (memCol) {
        await queryAs(userId,
          `INSERT INTO entity_memory (user_id,entity_type,entity_id,${memCol}) VALUES ($1,'project',$2,$3)
           ON CONFLICT (user_id,entity_type,entity_id) DO UPDATE SET ${memCol}=EXCLUDED.${memCol}`,
          [userId,project_id,eventDateIso]);
      }

      const {rows:[statsRow]} = await queryAs(userId,
        `INSERT INTO user_stats (user_id,total_xp,events_logged) VALUES ($1,$2,1)
         ON CONFLICT (user_id) DO UPDATE
         SET total_xp=user_stats.total_xp+$2, events_logged=user_stats.events_logged+1
         RETURNING total_xp, events_logged`,
        [userId,xpEarned]);

      await queryAs(userId,
        `INSERT INTO xp_events (user_id,event_log_id,xp_earned,reason) VALUES ($1,$2,$3,$4)`,
        [userId,ev.id,xpEarned,event_type]).catch(() => {});

      const level = levelFromXp(statsRow.total_xp);
      return created({
        eventId: ev.id,
        stats: {total_xp:statsRow.total_xp, level, events_logged:statsRow.events_logged, xp_earned:xpEarned},
      });
    }

    // PUT /api/events/:id
    if (method === 'PUT' && id) {
      const {event_type,event_date,title,notes,private_notes,quantity,is_public} = JSON.parse(event.body||'{}');
      const eventDateIso = event_date ? new Date(event_date+'T12:00:00').toISOString() : null;
      const {rows} = await queryAs(userId,
        `UPDATE event_log
         SET event_type=$2, event_date=COALESCE($3,event_date),
             title=$4, notes=$5, private_notes=$6, quantity=$7, is_public=$8
         WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
        [id,event_type,eventDateIso,title||null,notes||null,private_notes||null,quantity||null,is_public]);
      if (!rows.length) return err(404,'Event not found');
      return ok(rows[0]);
    }

    // DELETE /api/events/:id
    if (method === 'DELETE' && id) {
      const {rows} = await queryAs(userId,
        `UPDATE event_log SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [id]);
      if (!rows.length) return err(404,'Event not found');
      return noContent();
    }

    return err(405,'Method not allowed');
  } catch(e) {
    if (e instanceof AuthError) return err(401,e.message);
    console.error('events handler error:',e);
    return err(500,'Internal server error');
  }
};

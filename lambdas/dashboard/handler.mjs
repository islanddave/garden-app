import { queryAs } from '../shared/db.mjs';
import { requireAuth, AuthError, ok, err, corsPreflight } from '../shared/auth.mjs';

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return corsPreflight();
  const method = event.requestContext?.http?.method;

  try {
    if (method !== 'GET') return err(405,'Method not allowed');
    const userId = await requireAuth(event);

    const [projectsResult, eventsResult, statsResult] = await Promise.all([
      queryAs(userId,
        `SELECT p.id, p.name, p.slug, p.status, p.start_date, p.location_id,
                em.last_watered_at, em.last_observed_at, em.last_fertilized_at
         FROM plant_projects p
         LEFT JOIN entity_memory em ON em.user_id=$1 AND em.entity_type='project' AND em.entity_id=p.id
         WHERE p.deleted_at IS NULL ORDER BY p.start_date DESC NULLS LAST`,
        [userId]),
      queryAs(userId,
        `SELECT el.id, el.event_type, el.created_at, el.project_id,
                pp.name AS project_name
         FROM event_log el
         LEFT JOIN plant_projects pp ON pp.id=el.project_id
         WHERE el.deleted_at IS NULL ORDER BY el.created_at DESC LIMIT 5`,
        [userId]),
      queryAs(userId,
        `SELECT total_xp, events_logged FROM user_stats WHERE user_id=$1`,
        [userId]),
    ]);

    return ok({
      projects: projectsResult.rows,
      recentEvents: eventsResult.rows,
      stats: statsResult.rows[0] || {total_xp:0, events_logged:0},
    });
  } catch(e) {
    if (e instanceof AuthError) return err(401,e.message);
    console.error('dashboard handler error:',e);
    return err(500,'Internal server error');
  }
};

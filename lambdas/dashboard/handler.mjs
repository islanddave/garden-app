// Lambda: /api/dashboard
// Routes: GET / — aggregated summary for authenticated user
//
// Returns:
//   recent_events     - last 10 events across all projects
//   project_count     - total non-deleted projects
//   active_projects   - projects with status = 'active'
//   planning_projects - projects with status = 'planning'
//   total_plants      - total non-deleted plants
//   xp, level, current_streak, longest_streak, last_active_date, total_events
//     (from user_stats; returns safe defaults if row doesn't exist yet)
//
// All three sub-queries run in parallel via Promise.all for latency.

import { queryAs } from '../shared/db.mjs';
import { requireAuth, AuthError, ok, err, corsPreflight } from '../shared/auth.mjs';

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return corsPreflight();

  const method = event.requestContext?.http?.method;

  try {
    const userId = await requireAuth(event);

    if (method === 'GET') {
      const [eventsRes, countsRes, statsRes] = await Promise.all([
        queryAs(userId,
          `SELECT e.id, e.event_type, e.event_date, e.title, e.notes,
                  e.quantity, e.is_public, e.project_id, e.location_id,
                  p.name AS project_name, p.slug AS project_slug,
                  l.name AS location_name
           FROM event_log e
           LEFT JOIN plant_projects p ON p.id = e.project_id
           LEFT JOIN locations l ON l.id = e.location_id
           WHERE e.deleted_at IS NULL
           ORDER BY e.event_date DESC
           LIMIT 10`,
        ),

        queryAs(userId,
          `SELECT
             COUNT(*) FILTER (WHERE pp.deleted_at IS NULL)                         AS total_projects,
             COUNT(*) FILTER (WHERE pp.deleted_at IS NULL AND pp.status = 'active')    AS active_projects,
             COUNT(*) FILTER (WHERE pp.deleted_at IS NULL AND pp.status = 'planning')  AS planning_projects,
             COUNT(pl.id) FILTER (WHERE pl.deleted_at IS NULL)                     AS total_plants
           FROM plant_projects pp
           LEFT JOIN plants pl ON pl.project_id = pp.id`,
        ),

        // user_stats: safe fallback if row missing or user_id not yet TEXT type
        queryAs(userId,
          `SELECT xp, level, current_streak, longest_streak,
                  last_active_date, total_events
           FROM user_stats
           WHERE user_id = $1`,
          [userId],
        ).catch(() => ({ rows: [] })),
      ]);

      const stats  = statsRes.rows[0]  || {
        xp: 0, level: 1, current_streak: 0, longest_streak: 0,
        last_active_date: null, total_events: 0,
      };
      const counts = countsRes.rows[0] || {
        total_projects: 0, active_projects: 0, planning_projects: 0, total_plants: 0,
      };

      return ok({
        recent_events:     eventsRes.rows,
        project_count:     Number(counts.total_projects),
        active_projects:   Number(counts.active_projects),
        planning_projects: Number(counts.planning_projects),
        total_plants:      Number(counts.total_plants),
        xp:                stats.xp     ?? 0,
        level:             stats.level  ?? 1,
        current_streak:    stats.current_streak   ?? 0,
        longest_streak:    stats.longest_streak   ?? 0,
        last_active_date:  stats.last_active_date ?? null,
        total_events:      stats.total_events     ?? 0,
      });
    }

    return err(405, 'Method not allowed');

  } catch (e) {
    if (e instanceof AuthError) return err(401, e.message);
    console.error('dashboard handler error:', e);
    return err(500, 'Internal server error');
  }
};

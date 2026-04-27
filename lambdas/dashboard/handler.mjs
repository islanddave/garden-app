// Lambda: /api/dashboard
// SKELETON — implement queries in DB-MIGRATE-2
// Pattern: same as projects/handler.mjs (requireAuth → queryAs → ok/err)

import { queryAs, queryPublic } from '../shared/db.mjs';
import { requireAuth, AuthError, ok, created, noContent, err, corsPreflight } from '../shared/auth.mjs';

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return corsPreflight();

  try {
    const userId = await requireAuth(event);
    const method = event.requestContext?.http?.method;
    const id = (event.rawPath || '').split('/').filter(Boolean)[2] || null;

    // TODO DB-MIGRATE-2: implement full CRUD for dashboard
    // Reference: projects/handler.mjs for route structure
    // Tables: public.dashboard (verify exact table name vs entity name)

    return err(501, 'dashboard handler not yet implemented');

  } catch (e) {
    if (e instanceof AuthError) return err(401, e.message);
    console.error('dashboard handler error:', e);
    return err(500, 'Internal server error');
  }
};

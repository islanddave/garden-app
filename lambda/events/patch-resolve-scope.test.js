// BUG-EVENTSPATCHRESOLVE-001 — PATCH /api/events/:id (resolve) uses the two-arm ownership rule.
//
// THE DEFECT. The resolve UPDATE scoped ownership with `FROM public.container pp WHERE ... pp.id =
// el.project_id AND pp.created_by = ANY(h)`: the container arm alone. A project-less flagged event
// (plant-anchored, project_id NULL — eventOwnership.js "THE RULE") matched nothing and 404'd its own
// owner, and the route had no isEventOwned re-check, unlike GET, PUT and DELETE on the same path.
//
// HOW THIS PROVES IT. The handler runs for real against a stub driver. The stub cannot execute SQL, so
// it answers the pre-read and the UPDATE by reading the SQL TEXT: an ownership arm counts only if the
// issued statement carries it, and then only for a household owner bound into that statement. The
// pre-fix route (no pre-read, container arm only) therefore 404s the project-less case here exactly as
// it did against Postgres, and dropping the isEventOwned gate lets a row the SQL handed back through.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';
import { decommentSqlDashSpace as decomment } from '../_test-stubs/handlerSource.js';

const rec = vi.hoisted(() => ({ sent: [], tx: 0, respond: () => [] }));

vi.mock('@neondatabase/serverless', () => ({
  neon: () => {
    const text = (strings) => strings.reduce((acc, s, i) => acc + (i ? `$${i}` : '') + s, '');
    const sql = (strings, ...values) => {
      const q = { text: text(strings), values };
      Object.defineProperty(q, 'then', {
        enumerable: false,
        value: (ok, err) => {
          rec.sent.push({ text: q.text, values: q.values, tx: null });
          return Promise.resolve().then(() => rec.respond(q)).then(ok, err);
        },
      });
      return q;
    };
    sql.transaction = async (stmts) => {
      rec.tx += 1;
      const out = [];
      for (const q of stmts) {
        rec.sent.push({ text: q.text, values: q.values, tx: rec.tx });
        out.push(await rec.respond(q));
      }
      return out;
    };
    return sql;
  },
}));

const { handler } = await import('./index.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

const USER = 'user_stub_owner';
const STRANGER = 'user_stub_stranger';
const EVENT = '7d1e2f3a-4b5c-4d6e-8f70-819203a4b5c6';
const CONTAINER = 'c0c0c0c0-1111-4222-8333-444455556666';

const isPreRead = (t) => /AS plant_owner_id/.test(t) && /flagged_as_issue = true/.test(t);
const isResolve = (t) => /UPDATE event_log el\s+SET resolved_at = COALESCE/.test(t);
const projectArm = (t) => /el\.project_id IS NOT NULL/.test(t) || /pp\.id = el\.project_id/.test(t);
const plantArm = (t) => /el\.project_id IS NULL\s+AND (EXISTS \(\s*SELECT 1 FROM public\.garden_node pn|pn\.created_by)/.test(t);

/** Answer the route's statements for one event fixture, honouring only the arms each statement has. */
function serve(f) {
  rec.respond = (q) => {
    const t = q.text;
    const household = q.values.find(Array.isArray) ?? [];
    const owned = (f.project_id != null && projectArm(t) && household.includes(f.project_owner))
      || (f.project_id == null && plantArm(t) && household.includes(f.plant_owner));
    if (isPreRead(t)) {
      return owned ? [{ project_id: f.project_id, project_owner_id: f.project_owner ?? null, plant_owner_id: f.plant_owner ?? null }] : [];
    }
    if (isResolve(t)) {
      return owned ? [{
        id: EVENT, project_id: f.project_id, event_type: 'pest_observed', flagged_as_issue: true,
        severity: 'low', resolved_at: '2026-10-15T00:00:00Z', resolved_by: USER,
        created_at: '2026-10-14T00:00:00Z', qualifies_for_achievement: false,
      }] : [];
    }
    if (/AS tz/.test(t)) return [{ tz: 'America/New_York' }];
    return [];
  };
}

async function patch(body = { resolved: true }) {
  rec.sent = [];
  rec.tx = 0;
  const res = await handler({
    requestContext: { http: { method: 'PATCH' } },
    rawPath: `/api/events/${EVENT}`,
    headers: { authorization: 'Bearer stub-token' },
    body: JSON.stringify(body),
  });
  return { status: res.statusCode, body: JSON.parse(res.body || '{}'), sent: rec.sent };
}

beforeEach(() => { resetStubs(); stubState.verifyTokenResult = { sub: USER }; rec.respond = () => []; });

describe('BUG-EVENTSPATCHRESOLVE-001 — PATCH resolve ownership, executed', () => {
  it('resolves a project-less flagged event its planting owner holds (was a 404)', async () => {
    serve({ project_id: null, plant_owner: USER });
    const r = await patch();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.resolved_by).toBe(USER);
  });

  it('404s a project-less event on another household\'s planting, and writes nothing', async () => {
    serve({ project_id: null, plant_owner: STRANGER });
    const r = await patch();
    expect(r.status).toBe(404);
    expect(r.sent.some((s) => isResolve(s.text))).toBe(false);
  });

  it('still resolves a project-anchored event in the household\'s container', async () => {
    serve({ project_id: CONTAINER, project_owner: USER, plant_owner: STRANGER });
    const r = await patch();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('404s a project-anchored event in a foreign container even when the planting is the caller\'s', async () => {
    // The plant arm applies ONLY when project_id IS NULL — no project-anchored event changes hands.
    serve({ project_id: CONTAINER, project_owner: STRANGER, plant_owner: USER });
    const r = await patch();
    expect(r.status).toBe(404);
    expect(r.sent.some((s) => isResolve(s.text))).toBe(false);
  });

  it('second gate: a row the pre-read hands back that isEventOwned rejects is a 404 with no write', async () => {
    // A widened SQL predicate cannot leak: the JS re-check on the row is independent of it.
    rec.respond = (q) => (isPreRead(q.text)
      ? [{ project_id: CONTAINER, project_owner_id: STRANGER, plant_owner_id: USER }]
      : []);
    const r = await patch();
    expect(r.status).toBe(404);
    expect(r.sent.filter((s) => s.tx !== null)).toHaveLength(0);
  });

  it('pre-reads before the transaction, and keeps set_config as transaction element 0', async () => {
    serve({ project_id: null, plant_owner: USER });
    const r = await patch();
    const pre = r.sent.findIndex((s) => isPreRead(s.text));
    const tx = r.sent.filter((s) => s.tx !== null);
    expect(pre).toBeGreaterThanOrEqual(0);
    expect(r.sent[pre].tx).toBeNull();
    expect(r.sent.indexOf(tx[0])).toBeGreaterThan(pre);
    expect(tx[0].text).toMatch(/set_config\('app\.actor_clerk_sub'/);
    expect(isResolve(tx[1].text)).toBe(true);
  });

  it('still 400s anything but resolved:true before reading', async () => {
    const r = await patch({ resolved: false });
    expect(r.status).toBe(400);
    expect(r.sent).toHaveLength(0);
  });
});

describe('BUG-EVENTSPATCHRESOLVE-001 — PATCH resolve SQL text', () => {
  const at = SRC.indexOf("if (method === 'PATCH') {");
  const route = SRC.slice(at, SRC.indexOf('const tzRows', at));

  it('the pre-read selects exactly the three columns isEventOwned reads, under both arms', () => {
    expect(route).toMatch(/SELECT el\.project_id,\s+pp\.created_by AS project_owner_id,\s+pn\.created_by AS plant_owner_id\s+FROM event_log el/);
    expect(route).toMatch(/LEFT JOIN public\.container pp ON pp\.id = el\.project_id AND pp\.deleted_at IS NULL/);
    expect(route).toMatch(/LEFT JOIN public\.garden_node pn ON pn\.id = el\.plant_id AND pn\.deleted_at IS NULL/);
    expect(route).toMatch(/\(el\.project_id IS NOT NULL AND pp\.created_by = ANY\(\$\{householdIds\}\)\)\s+OR \(el\.project_id IS NULL\s+AND pn\.created_by = ANY\(\$\{householdIds\}\)\)/);
    expect(route).toMatch(/if \(!isEventOwned\(owned\[0\], householdIds\)\) return resp\(404/);
  });

  it('the UPDATE re-asserts both arms as EXISTS and no longer joins the container', () => {
    const upd = route.slice(route.indexOf('UPDATE event_log el'), route.indexOf('RETURNING'));
    expect(upd).toMatch(/SET resolved_at = COALESCE\(el\.resolved_at, NOW\(\)\)/);
    expect(upd).not.toMatch(/FROM public\.container pp\s+WHERE el\.id/);
    expect(upd).toMatch(/el\.project_id IS NOT NULL AND EXISTS \(\s*SELECT 1 FROM public\.container pp\s+WHERE pp\.id = el\.project_id AND pp\.deleted_at IS NULL\s+AND pp\.created_by = ANY\(\$\{householdIds\}\)\)\)/);
    expect(upd).toMatch(/el\.project_id IS NULL AND EXISTS \(\s*SELECT 1 FROM public\.garden_node pn\s+WHERE pn\.id = el\.plant_id AND pn\.deleted_at IS NULL\s+AND pn\.created_by = ANY\(\$\{householdIds\}\)\)\)/);
  });
});

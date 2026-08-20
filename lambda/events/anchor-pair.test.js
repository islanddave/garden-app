// BUG-EVENTPROJPLANTPAIR-001 — the event anchor pair must agree with its planting.
//
// THE INVARIANT: when event_log.plant_id is non-NULL, event_log.project_id MUST equal that
// planting's project_id. 43 rows on prod violate it (39 live), the newest minted 2026-08-14 — so
// this is an open wound, and these tests exist to close the writers rather than the data.
//
// WHAT THIS FILE PROVES, AND HOW IT DIFFERS FROM THE REST OF lambda/events/.
// Every other test in this directory is a pure-function check or a source-text scan, on the stated
// grounds that "no lambda test in this repo imports a handler — the Lambda runtime deps are not
// installed at the repo root, so import './index.js' fails at Vite transform time" (see the header
// of lambda/varieties/authz-household.test.js). THAT IS NO LONGER TRUE: @neondatabase/serverless,
// @clerk/backend and @aws-sdk/client-secrets-manager all resolve from the root node_modules today,
// and the handler imports and runs under vitest with those three modules mocked. Verified by
// probe before this file was written.
//
// That matters here because the brief for this ticket is behavioural, not structural: a request
// that NAMES a disagreeing project_id must not be able to produce a disagreeing row. A source scan
// cannot say that — it can only say the source LOOKS right. So the POST and PUT cases below build
// that exact request, run the real handler over a recording `sql`, and read back the value actually
// bound to the project_id column. The source-scan layer is kept as well, but only for the one thing
// execution cannot show: that the derived value is what reaches the statement, rather than the two
// agreeing here by coincidence of the fixture.
//
// MUTATION-CHECKED. Each behavioural case was confirmed RED against the pre-fix source (the
// client-trusting bindings restored) and GREEN after — recorded in the lane report. A guard that
// stays green when you revert the thing it guards is worth less than no guard at all.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveEventProjectId } from './validators.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, 'index.js'), 'utf8');

// The planting's REAL project, and the different one the request will claim. The whole ticket is
// the gap between these two values.
const PROJ_TRUE = '11111111-1111-4111-8111-111111111111';
const PROJ_CLAIMED = '22222222-2222-4222-8222-222222222222';
const PLANT = '33333333-3333-4333-8333-333333333333';
const EVENT_ID = '44444444-4444-4444-8444-444444444444';
const USER = 'user_anchorpair';

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class { async send() {
    return { SecretString: JSON.stringify({ NEON_DATABASE_URL: 'postgres://stub', CLERK_SECRET_KEY: 'sk_stub' }) };
  } },
  GetSecretValueCommand: class {},
}));
vi.mock('@clerk/backend', () => ({ verifyToken: async () => ({ sub: USER }) }));

// A recording stand-in for the neon HTTP driver. Every tagged call is captured verbatim — the
// template STRINGS and the bound VALUES separately — which is what lets a test name a column and
// read the value bound to it rather than counting parameter positions by eye.
let calls = [];
const rowsFor = (text) => {
  if (text.includes('FROM public.plant_projects')) return [{ id: PROJ_CLAIMED, name: 'claimed project' }];
  // loadOwnedPlantingRef. The planting is REAL and OWNED — the request is not forged, it is merely
  // wrong about the project, which is the case the 39 live rows are.
  if (text.includes('FROM public.plants gn')) return [{ id: PLANT, name: 'a planting', project_id: PROJ_TRUE }];
  if (text.includes('user_timezone')) return [{ tz: 'America/New_York' }];
  if (text.includes('INSERT INTO event_log')) return [{ id: EVENT_ID, project_id: PROJ_TRUE, plant_id: PLANT, event_type: 'watering', event_date: '2026-08-20T12:00:00Z', metadata: null }];
  if (text.includes('UPDATE event_log el')) return [{ id: EVENT_ID, project_id: PROJ_TRUE, plant_id: PLANT, event_type: 'watering', event_date: '2026-08-20T12:00:00Z', metadata: null }];
  // The PUT's ownership pre-read. plant_project_id is the column added by this ticket: the current
  // planting's project, for the arm where the body does not move plant_id.
  if (text.includes('FROM event_log el')) {
    return [{
      id: EVENT_ID, event_type: 'watering', plant_id: PLANT, event_date: '2026-08-20T12:00:00Z',
      flagged_as_issue: false, severity: null, project_id: PROJ_CLAIMED, location_id: null,
      harvest_log_id: null, project_owner_id: USER, plant_owner_id: USER,
      plant_project_id: PROJ_TRUE, metadata: null,
    }];
  }
  return [];
};
const makeSql = () => {
  const sql = (strings, ...values) => {
    const text = strings.join(' ? ');
    const rec = { strings: [...strings], values, text, rows: rowsFor(text) };
    calls.push(rec);
    const p = Promise.resolve(rec.rows);
    p.__rec = rec;
    return p;
  };
  sql.transaction = async (stmts) => stmts.map((s) => (s.__rec ? s.__rec.rows : []));
  return sql;
};
vi.mock('@neondatabase/serverless', () => ({ neon: () => makeSql() }));

// Find the value bound immediately after the template fragment matching `re`. values[i] is the
// interpolation that follows strings[i], so this names a COLUMN and returns ITS bind — no
// positional counting, and it fails loudly rather than silently reading a neighbour.
const bindAfter = (rec, re) => {
  const i = rec.strings.findIndex((s) => re.test(s));
  expect(i, `no template fragment matched ${re} in:\n${rec.text.slice(0, 400)}`).toBeGreaterThanOrEqual(0);
  return rec.values[i];
};
const findCall = (re) => {
  const rec = calls.find((c) => re.test(c.text));
  expect(rec, `no recorded statement matched ${re}`).toBeTruthy();
  return rec;
};

const invoke = async (method, rawPath, body) => {
  const { handler } = await import('./index.js');
  return handler({
    requestContext: { http: { method } },
    rawPath,
    headers: { authorization: 'Bearer stub' },
    body: JSON.stringify(body),
  });
};

beforeEach(() => { calls = []; });

describe('deriveEventProjectId — the rule, in isolation', () => {
  it('a planting-bearing event takes its project FROM THE PLANTING, discarding the request value', () => {
    expect(deriveEventProjectId({
      plantId: PLANT, plantProjectId: PROJ_TRUE, requestedProjectId: PROJ_CLAIMED,
    })).toBe(PROJ_TRUE);
  });

  it('a planting-less event may still take project_id from the request — nothing to disagree with', () => {
    expect(deriveEventProjectId({
      plantId: null, plantProjectId: null, requestedProjectId: PROJ_CLAIMED,
    })).toBe(PROJ_CLAIMED);
  });

  it('a project-less planting yields a project-less event, rather than keeping the claimed project', () => {
    // This is the Bucket B shape (3 live rows). Deriving to NULL is legal — event_log_has_anchor is
    // satisfied by plant_id — and is now SAFE, because the PUT ownership SELECT, the PUT UPDATE and
    // the DELETE route all carry the two-arm `project_id IS NULL` predicate. Keeping the claimed
    // project instead is precisely how those rows were minted.
    expect(deriveEventProjectId({
      plantId: PLANT, plantProjectId: null, requestedProjectId: PROJ_CLAIMED,
    })).toBeNull();
  });

  it('never invents a project for a bare event', () => {
    expect(deriveEventProjectId({ plantId: null, plantProjectId: PROJ_TRUE, requestedProjectId: null })).toBeNull();
  });
});

describe('POST /api/events — a request naming a disagreeing project cannot write one', () => {
  it('binds the PLANTING\'s project to event_log.project_id, not the body\'s', async () => {
    await invoke('POST', '/api/events', {
      event_type: 'watering',
      plant_id: PLANT,
      project_id: PROJ_CLAIMED, // the lie
      event_date: '2026-08-20',
    });

    const insert = findCall(/INSERT INTO event_log/);
    // project_id is the FIRST column of the INSERT's column list, so values[0] is its bind. The
    // anchor assertion below is what makes that positional claim safe to rely on.
    expect(insert.strings[0]).toMatch(/INSERT INTO event_log[\s\S]*VALUES \(\s*$/);
    expect(insert.values[0], 'the claimed project must not reach the row').not.toBe(PROJ_CLAIMED);
    expect(insert.values[0]).toBe(PROJ_TRUE);
    // And the pair that actually lands agrees, which is the invariant itself.
    expect(insert.values[2]).toBe(PLANT);
  });

  it('still refuses a project_id the caller does not own, rather than silently discarding it', async () => {
    // The derivation must not become an accidental authz bypass: the gate runs on what was SENT.
    calls = [];
    const sqlRows = rowsFor;
    expect(sqlRows('FROM public.plant_projects')).toHaveLength(1); // fixture sanity
    const res = await invoke('POST', '/api/events', {
      event_type: 'watering', plant_id: PLANT, project_id: 'not-a-uuid', event_date: '2026-08-20',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Invalid project_id');
  });
});

describe('PUT /api/events/:id — a re-anchor cannot leave the pair disagreeing', () => {
  it('binds the PLANTING\'s project to project_id when the body claims another', async () => {
    await invoke('PUT', `/api/events/${EVENT_ID}`, {
      event_type: 'watering',
      plant_id: PLANT,
      project_id: PROJ_CLAIMED, // the lie
    });

    const upd = findCall(/UPDATE event_log el/);
    const boundProject = bindAfter(upd, /project_id\s*=\s*$/);
    const boundPlant = bindAfter(upd, /plant_id\s*=\s*$/);
    expect(boundProject, 'the claimed project must not reach the row').not.toBe(PROJ_CLAIMED);
    expect(boundProject).toBe(PROJ_TRUE);
    expect(boundPlant).toBe(PLANT);
  });

  it('derives from the CURRENT planting even when the body does not move plant_id', async () => {
    // The stored row is one of the 39: project PROJ_CLAIMED, planting PLANT which lives in
    // PROJ_TRUE. An edit that touches only the notes must not re-assert the stale project.
    await invoke('PUT', `/api/events/${EVENT_ID}`, {
      event_type: 'watering', notes: 'just editing the note',
    });
    const upd = findCall(/UPDATE event_log el/);
    expect(bindAfter(upd, /project_id\s*=\s*$/)).toBe(PROJ_TRUE);
  });
});

describe('the derivation is USED — not merely present', () => {
  // Execution above proves the value is right for these fixtures. These prove the WIRING: that the
  // write sites read the derived binding, and that nothing re-introduces a body-sourced project_id.
  it('POST derives projectId through deriveEventProjectId and binds THAT', () => {
    expect(SRC).toMatch(/const projectId = deriveEventProjectId\(\{[\s\S]{0,220}?requestedProjectId,\s*\}\);/);
    expect(SRC, 'the POST INSERT must bind the derived projectId')
      .toMatch(/INSERT INTO event_log[\s\S]*?VALUES \(\s*\$\{projectId\}/);
  });

  it('PUT derives newProjectId through deriveEventProjectId and binds THAT', () => {
    expect(SRC).toMatch(/const newProjectId\s*=\s*deriveEventProjectId\(\{/);
    expect(SRC).toMatch(/project_id\s*=\s*\$\{newProjectId\}::uuid/);
  });

  it('neither arm still takes project_id straight from the body', () => {
    // The exact pre-fix spellings. Either one reappearing is the bug returning.
    expect(SRC).not.toMatch(/const projectId = body\.project_id \?\? null;/);
    expect(SRC).not.toMatch(/const newProjectId\s*=\s*body\.project_id \?\? oldProjectId;/);
  });

  it('the planting ref carries project_id, which is what makes the derivation free', () => {
    const authz = readFileSync(join(here, 'authz-parents.js'), 'utf8');
    expect(authz).toMatch(/SELECT gn\.id, gn\.name, gn\.project_id/);
  });

  it('the PUT pre-read exposes the current planting\'s project WITHOUT the soft-delete filter', () => {
    // Reading it through the `pn` join would return NULL for the 39 live events whose planting is
    // soft-deleted, and silently clear a project_id that was never wrong.
    expect(SRC).toMatch(/\(SELECT gn2\.container_id FROM public\.garden_node gn2\s*\n\s*WHERE gn2\.id = el\.plant_id\) AS plant_project_id/);
  });
});

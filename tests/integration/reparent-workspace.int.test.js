// tests/integration/reparent-workspace.int.test.js — V5-SPACESENTINELDOC-001 (multi-space Phase 1, step 1.9)
// on real Postgres.
//
// WHAT THIS PROVES. migrations/v5-spacefk-001/0a-fold.sql moves ten containers from the nil workspace onto the
// one Space. The reparent path is one of the two Lambda readers of a container's workspace_id
// (lambda/container-workspace-census.test.js): reparentCore selects it in its tgt CTE and copies it into
// reparent_event in the same statement. Before the fold, moving one of the ten wrote the nil id into the event
// (the local rehearsal's red control, migrations/v5-spacefk-001/README.md). Here a container in the folded
// shape, the shape every container has after the fold, is moved and undone through the projects handler, and
// each reparent_event row is read back: it carries the container's own Space, the one Space there is, and that
// value is a row in spaces. A second pair sits on a fixture Space whose id is not the sentinel, so "copies" is
// proved rather than "writes the one Space". A 409 for a stale version is the one-time cost the README names for a
// page loaded before the fold.
//
// No nil-workspace fixture: after 0b/0c the database refuses one (23503), and this file must pass on both sides
// of that apply. reparent_event has no foreign key (prod and staging, 2026-10-16), so its rows are torn down
// here by op and by subject; the global sweep (_cleanup.js) carries the same step for a failed run.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { settle, assertFixtureId } from './_cleanup.js'
import { handler as projectsHandler } from '../../lambda/projects/index.js'

const RUN = testRunId()
const USER = `user_int_rpws_${RUN}`
const ENV_KEY = 'GARDEN_HOUSEHOLD_IDS'
const SPACE = '00000000-0000-0000-0000-000000000001'

let savedEnv
let parent, child
// QA MINOR: a second container pair on a fixture Space whose id is not the sentinel, so a reparentCore that wrote a
// constant instead of copying the container's own workspace_id reds. created_by = USER: the spaces step of the
// global sweep (_cleanup.js NS_SPACES) takes it on a failed run, and nothing hangs off it but these two containers.
let fixtureSpace, otherParent, otherChild
const ops = []

const call = (method, path, body) => callHandler(projectsHandler, { method, path, body, userId: USER })
const version = async (id) => (await directSql`SELECT version FROM plant_projects WHERE id = ${id}`)[0].version
const eventOf = async (opId) => (await directSql`
  SELECT r.subject_id, r.old_parent_id, r.new_parent_id, r.moved_by, r.workspace_id,
         EXISTS (SELECT 1 FROM spaces s WHERE s.id = r.workspace_id) AS names_a_space
    FROM reparent_event r WHERE r.op_id = ${opId}`)[0]

beforeAll(async () => {
  savedEnv = process.env[ENV_KEY]
  process.env[ENV_KEY] = USER
  setTestUserId(USER)
  parent = (await insertProject({ name: `int-rpws-parent-${RUN}`, createdBy: USER, kind: 'category' })).id
  child = (await insertProject({ name: `int-rpws-child-${RUN}`, createdBy: USER, kind: 'category' })).id
  fixtureSpace = (await directSql`
    INSERT INTO spaces (name, created_by) VALUES (${`int-rpws-space-${RUN}`}, ${USER}) RETURNING id`)[0].id
  const onFixtureSpace = async (name) => (await directSql`
    INSERT INTO plant_projects (name, slug, kind, created_by, workspace_id)
    VALUES (${name}, ${name}, 'category', ${USER}, ${fixtureSpace}) RETURNING id`)[0].id
  otherParent = await onFixtureSpace(`int-rpws-oparent-${RUN}`)
  otherChild = await onFixtureSpace(`int-rpws-ochild-${RUN}`)
})

afterAll(async () => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = savedEnv
  assertFixtureId(USER)
  await settle('reparent-workspace', [
    () => directSql`DELETE FROM reparent_event WHERE moved_by = ${USER} OR op_id = ANY(${ops}::uuid[])`,
    () => directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`,
    () => directSql`DELETE FROM spaces WHERE created_by = ${USER}`,
  ])
})

describe('PRECONDITION — the fixture container is in the folded shape', () => {
  it('its workspace_id is the one Space, and that is a row in spaces', async () => {
    const [c] = await directSql`
      SELECT p.workspace_id, EXISTS (SELECT 1 FROM spaces s WHERE s.id = p.workspace_id) AS names_a_space
        FROM plant_projects p WHERE p.id = ${child}`
    expect(c).toEqual({ workspace_id: SPACE, names_a_space: true })
  })
})

describe('V5-SPACESENTINELDOC-001 — a reparent copies the container\'s Space into reparent_event', () => {
  it('move: 200, and the event row carries the container\'s workspace_id, which names a Space', async () => {
    const op = randomUUID()
    ops.push(op)
    const v = await version(child)
    const res = await call('POST', `/api/projects/${child}/reparent`, { op_id: op, new_parent_id: parent, expected_version: v })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ id: child, parent_project_id: parent, old_parent_id: null })
    const [c] = await directSql`SELECT workspace_id FROM plant_projects WHERE id = ${child}`
    expect(await eventOf(op)).toEqual({
      subject_id: child, old_parent_id: null, new_parent_id: parent, moved_by: USER,
      workspace_id: c.workspace_id, names_a_space: true,
    })
    expect(c.workspace_id).toBe(SPACE)
  })

  it('undo: the restore is itself a reparent, and its event row carries the Space too', async () => {
    const source = ops[0]
    const op = randomUUID()
    ops.push(op)
    const res = await call('POST', `/api/projects/${child}/reparent/restore`,
      { op_id: op, source_op_id: source, expected_version: await version(child) })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.parent_project_id).toBeNull()
    expect(await eventOf(op)).toMatchObject({ subject_id: child, old_parent_id: parent, new_parent_id: null,
      workspace_id: SPACE, names_a_space: true })
  })

  it('a container on another Space: the event row carries THAT Space, not the sentinel', async () => {
    expect(fixtureSpace).not.toBe(SPACE)
    const op = randomUUID()
    ops.push(op)
    const res = await call('POST', `/api/projects/${otherChild}/reparent`,
      { op_id: op, new_parent_id: otherParent, expected_version: await version(otherChild) })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await eventOf(op)).toEqual({
      subject_id: otherChild, old_parent_id: null, new_parent_id: otherParent, moved_by: USER,
      workspace_id: fixtureSpace, names_a_space: true,
    })
  })

  it('a page holding an older version gets 409 "Version conflict — reload and retry" and writes no event', async () => {
    const op = randomUUID()
    ops.push(op)
    const stale = (await version(child)) - 1
    const res = await call('POST', `/api/projects/${child}/reparent`, { op_id: op, new_parent_id: parent, expected_version: stale })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Version conflict — reload and retry')
    expect(await eventOf(op)).toBeUndefined()
  })
})

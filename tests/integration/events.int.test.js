// events.int.test.js — proves the HANDLER+MOCK layer: the real events handler runs against the
// ephemeral branch with SecretsManager + Clerk stubbed, and the bare-date noon-anchor (normalizeEventDate)
// persists correctly. This is the test that validates whether vi.mock intercepts the handler's
// nested-node_modules deps. Assertion verified against lambda/events: normalizeEventDate('YYYY-MM-DD')
// -> 'T12:00:00Z'; create returns the inserted row (id present). Status accepted as 200 or 201.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { handler } from '../../lambda/events/index.js'

const RUN = testRunId()
const USER = `user_int_events_${RUN}`
let projectId

beforeAll(async () => {
  setTestUserId(USER)
  const rows = await directSql`
    INSERT INTO plant_projects (name, slug, created_by)
    VALUES (${'int-proj-' + RUN}, ${'int-proj-' + RUN}, ${USER}) RETURNING id
  `
  projectId = rows[0].id
})

afterAll(async () => {
  await directSql`DELETE FROM event_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
})

describe('POST /api/events — bare-date noon-anchor (real handler + real SQL)', () => {
  it('stores YYYY-MM-DD as noon UTC and read-back confirms DB state', async () => {
    const bareDate = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const expected = bareDate + 'T12:00:00.000Z'
    const { status, body } = await callHandler(handler, {
      method: 'POST',
      path: '/api/events',
      body: { project_id: projectId, event_type: 'observation', event_date: bareDate, notes: 'int-test' },
    })
    expect([200, 201]).toContain(status)
    expect(body.id).toBeTruthy()
    const rows = await directSql`SELECT event_date FROM event_log WHERE id = ${body.id}`
    expect(rows).toHaveLength(1)
    expect(new Date(rows[0].event_date).toISOString()).toBe(expected)
  })
})

// BUG-NULLPROJEVENT-001 — the ownership rule for an event that may have no project.
//
// TIER, STATED UP FRONT. These tests EXECUTE the rule; they do not and cannot execute the SQL that
// enforces the same rule in lambda/events/index.js. Handler-invocation tests are structurally
// impossible in this suite — the Lambda runtime deps (@neondatabase/serverless, @clerk/backend,
// @aws-sdk/*) are deliberately absent from the root install, so importing any lambda index.js fails
// resolution in CI (resolve-stats-upsert.test.js states the same constraint). That is precisely why
// the rule was pulled OUT of the SQL into eventOwnership.js: the decision becomes executable, and
// index.js calls it as a second gate on every by-id route rather than only encoding it in a WHERE
// clause nothing can run.
//
// The SQL half was proven by running it read-only against live prod on 2026-08-12: the old inner
// join returned 0 rows for both orphan events, the new predicate returns both; across the whole
// corpus the reachable set went 14192 -> 14194 with 0 rows LOST; and the same predicate with a
// foreign household returned 0. See the commit message for the verbatim numbers.

import { describe, it, expect } from 'vitest'
import { eventOwnerId, isEventOwned } from './eventOwnership.js'

const HH = ['user_dave', 'user_jen']
const row = (o) => ({ project_id: null, project_owner_id: null, plant_owner_id: null, ...o })

describe('eventOwnerId', () => {
  it('a project-anchored event is owned by its container', () => {
    expect(eventOwnerId(row({ project_id: 'p1', project_owner_id: 'user_dave', plant_owner_id: 'user_jen' })))
      .toBe('user_dave')
  })

  it('a project-less event is owned by its planting', () => {
    expect(eventOwnerId(row({ project_id: null, plant_owner_id: 'user_dave' }))).toBe('user_dave')
  })

  // The keystone. If the arms were chosen by "did the container join produce a row" instead of by
  // project_id, a project-anchored event whose container is missing or soft-deleted would silently
  // fall through to the plant arm and become editable by the planting's owner. That is a privilege
  // change disguised as a reachability fix, and it is the one way this could go wrong quietly.
  it('a project-anchored event whose container is gone stays UNOWNED — it does not fall through to the plant', () => {
    const r = row({ project_id: 'p1', project_owner_id: null, plant_owner_id: 'user_dave' })
    expect(eventOwnerId(r)).toBeNull()
    expect(isEventOwned(r, HH)).toBe(false)
  })

  it('a project-less event whose planting is gone is unowned', () => {
    expect(eventOwnerId(row({ project_id: null, plant_owner_id: null }))).toBeNull()
  })

  it('handles a missing row', () => {
    expect(eventOwnerId(null)).toBeNull()
    expect(eventOwnerId(undefined)).toBeNull()
  })
})

describe('isEventOwned', () => {
  it('accepts both household members on either arm', () => {
    for (const who of HH) {
      expect(isEventOwned(row({ project_id: 'p1', project_owner_id: who }), HH)).toBe(true)
      expect(isEventOwned(row({ plant_owner_id: who }), HH)).toBe(true)
    }
  })

  it('rejects a foreign owner on either arm', () => {
    expect(isEventOwned(row({ project_id: 'p1', project_owner_id: 'user_stranger' }), HH)).toBe(false)
    expect(isEventOwned(row({ plant_owner_id: 'user_stranger' }), HH)).toBe(false)
  })

  // V4-AUTHZRESIDUE-001. In Postgres '' = ANY(ARRAY['']) is TRUE, so an empty Clerk subject is a
  // live ownership value rather than a no-match. The JS gate must not be the looser of the two.
  it('an empty owner id is never owned, even against an empty-string household', () => {
    expect(isEventOwned(row({ plant_owner_id: '' }), [''])).toBe(false)
    expect(isEventOwned(row({ project_id: 'p1', project_owner_id: '' }), [''])).toBe(false)
  })

  it('an empty or non-array household owns nothing', () => {
    const r = row({ plant_owner_id: 'user_dave' })
    expect(isEventOwned(r, [])).toBe(false)
    expect(isEventOwned(r, null)).toBe(false)
    expect(isEventOwned(r, undefined)).toBe(false)
  })

  // The regression this whole change exists to prevent: the two live prod rows, in the shape the
  // by-id reads hand back. Before the fix these were 404 on view, edit AND delete.
  it('the two live prod orphans (plant-anchored, project-less) are owned', () => {
    const orphans = [
      { label: 'fd4c70bc watering 2026-08-11', plant_owner_id: 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI' },
      { label: '29aca970 status_change 2026-08-12', plant_owner_id: 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI' },
    ]
    const household = ['user_3D2gM0hIl03gjW3JM2DjtPzm0jI', 'user_3E2xA85kQhr1vSZhiv4W1GLudJV']
    for (const o of orphans) {
      expect(isEventOwned(row({ project_id: null, plant_owner_id: o.plant_owner_id }), household), o.label).toBe(true)
    }
  })
})

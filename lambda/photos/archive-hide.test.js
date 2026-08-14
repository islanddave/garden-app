// V4-ARCHIVEHIDE-001 (L2) — archived plantings must not be LOADED by an aggregate photo gallery.
//
// The requirement is "must not be loaded at all", so the only fix that satisfies it is a WHERE-clause
// predicate: a client-side filter still queries, serialises and ships the row. These assertions are
// therefore about SQL TEXT, not about a filtered result — the leak this closes was invisible to every
// response-shape test because the response shape never changed.
//
// AXIS: archived_at. It is orthogonal to deleted_at (lambda/plants/index.js archives a row whose
// deleted_at is still NULL), so the last `it` pins that no deleted_at predicate was traded away for
// the new one — filtering the wrong axis either does nothing or hides live data.
//
// Static-source for the same reason as the sibling files: lambda/photos/index.js imports
// @aws-sdk/@clerk/@neondatabase at module load and is not importable from repo root.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — the sibling files' guard, and it matters
// more here than usual: this change ships a long rationale comment that itself names every predicate
// being asserted, so without decommenting every assertion below would find its own epitaph.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// The four aggregate branches, sliced by their JS guard so an assertion cannot pass by finding the
// predicate in a neighbouring branch. Order in source is: attachedTo, locationId, projectId, spaceId,
// unfiltered — pinned independently by attachment-gallery/location-gallery.test.js.
const iAttached = SRC.indexOf('if (attachedTo) {');
const iLocation = SRC.indexOf('} else if (locationId) {');
const iProject = SRC.indexOf('} else if (projectId) {');
const iSpace = SRC.indexOf('} else if (spaceId) {');
const iUnfiltered = SRC.indexOf('} else {', iSpace);

const BRANCHES = {
  locationId: SRC.slice(iLocation, iProject),
  projectId: SRC.slice(iProject, iSpace),
  spaceId: SRC.slice(iSpace, iUnfiltered),
  unfiltered: SRC.slice(iUnfiltered, iUnfiltered + 1200),
};

const PLANT_ANTIJOIN = /NOT EXISTS \(\s*SELECT 1 FROM public\.garden_node gna\s*WHERE gna\.id = p\.plant_id AND gna\.archived_at IS NOT NULL\s*\)/;
const EVENT_ANTIJOIN = /NOT EXISTS \(\s*SELECT 1 FROM public\.event_log ea\s*JOIN public\.garden_node gne ON gne\.id = ea\.plant_id\s*WHERE ea\.id = p\.event_id AND ea\.deleted_at IS NULL\s*AND gne\.archived_at IS NOT NULL\s*\)/;

describe('photos Lambda — archived plantings are excluded from aggregate galleries (L2)', () => {
  it('the branch slices are real (a broken index would make every assertion vacuous)', () => {
    for (const i of [iAttached, iLocation, iProject, iSpace, iUnfiltered]) expect(i).toBeGreaterThan(-1);
    expect(iLocation).toBeGreaterThan(iAttached);
    expect(iUnfiltered).toBeGreaterThan(iSpace);
    for (const [name, block] of Object.entries(BRANCHES)) {
      expect(block, `${name} slice is empty`).toMatch(/FROM photos p/);
    }
  });

  for (const name of ['locationId', 'projectId', 'spaceId', 'unfiltered']) {
    it(`the ${name} branch excludes photos attached directly to an archived planting`, () => {
      expect(BRANCHES[name]).toMatch(PLANT_ANTIJOIN);
    });

    // 21 of the 28 leaked photos (prod, 2026-08-13) carry a NULL plant_id and reach the archived
    // planting only through photos.event_id -> event_log.plant_id. A single predicate on p.plant_id
    // closes a quarter of the leak while reading as though it closed all of it.
    it(`the ${name} branch excludes photos reaching an archived planting through their event`, () => {
      expect(BRANCHES[name]).toMatch(EVENT_ANTIJOIN);
    });
  }

  // The ONE deliberate route. PlantingDetail fetches ?attachedTo=<id> (src/pages/PlantingDetail.jsx),
  // and every row it returns belongs to that one planting by construction — so the predicate is a
  // no-op when the planting is live and blanks the page when it is archived. Since an archived
  // planting is reachable ONLY by its own detail page (lambda/events/index.js: "Deletion hides;
  // archiving does not"), filtering here would delete the last route to it.
  it('does NOT filter the ?attachedTo branch — that is the archived planting own gallery', () => {
    const attachedBlock = SRC.slice(iAttached, iLocation);
    expect(attachedBlock).toMatch(/p\.plant_id = \$\{attachedTo\}/);
    expect(attachedBlock).not.toMatch(/archived_at/);
  });

  it('did not trade the deleted_at axis for the archived_at axis', () => {
    for (const [name, block] of Object.entries(BRANCHES)) {
      expect(block, `${name} lost its deleted_at predicate`).toMatch(/AND p\.deleted_at IS NULL/);
    }
  });

  // BUG-PHOTOARCHAXIS-001 — the two axes must stay SEPARATELY OBSERVABLE, which the EVENT_ANTIJOIN
  // regex above now encodes but would not FAIL LOUDLY for: drop the scope and that regex simply
  // stops matching, and the failure reads as "the anti-join went missing" rather than "the axes were
  // conflated". These three pin the distinction directly.
  //
  // MUTATION (verified): delete `AND ea.deleted_at IS NULL` from the four anti-joins -> the first
  // `it` below goes RED on all four branches with the conflation named in the message.
  for (const name of ['locationId', 'projectId', 'spaceId', 'unfiltered']) {
    it(`the ${name} branch scopes the event hop to LIVE events (archive axis only)`, () => {
      expect(BRANCHES[name],
        `${name} traverses photos.event_id -> event_log without scoping the intermediate to live ` +
        'rows, so a photo stranded on a soft-deleted event is hidden by the ARCHIVE predicate — ' +
        'the delete and archive axes are conflated').toMatch(/WHERE ea\.id = p\.event_id AND ea\.deleted_at IS NULL/);
    });
  }

  // The scope belongs on the INTERMEDIATE (ea), never on the destination (gne). Putting it on gne
  // would be the same conflation with the operands swapped: a soft-deleted-AND-archived planting
  // would stop being hidden, which IS a live visibility change (21 live photos reach an archived
  // planting through their event today).
  it('scopes the intermediate event, not the planting it reaches', () => {
    expect(SRC).not.toMatch(/gne\.deleted_at/);
    const scoped = SRC.match(/ea\.deleted_at IS NULL/g) ?? [];
    expect(scoped.length, 'expected the scope on all four aggregate branches').toBe(4);
  });

  // The plant anti-join is ONE hop and names the archive axis directly — there is no intermediate
  // to scope, and adding a deleted_at term there would be a real behaviour change rather than a
  // de-conflation. Pinned so a future sweep does not "make them consistent" by symmetry.
  it('leaves the single-hop plant anti-join on the archive axis alone', () => {
    for (const name of ['locationId', 'projectId', 'spaceId', 'unfiltered']) {
      expect(BRANCHES[name]).toMatch(PLANT_ANTIJOIN);
      expect(BRANCHES[name]).not.toMatch(/gna\.deleted_at/);
    }
  });
});

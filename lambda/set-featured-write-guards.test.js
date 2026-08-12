// DD3b — the WRITE half of INV-HERO: every set-featured validator must refuse a soft-deleted photo.
//
// WHY THIS EXISTS AS A SEPARATE, ENUMERATED GUARD. fetchSpaceHero's own comment ends: "do not delete
// it as redundant with the write check, and do not add it without the write check." The read half
// (the effective-hero derivation, guarded by hero-read-derivation.test.js) shipped first, and until
// W-DEL there was no route in the app that could produce a soft-deleted photo — so these four write
// guards were unreachable and were deliberately deferred. W-DEL makes them reachable in the same
// promote, and this is the assertion that says so.
//
// The failure they prevent is specific and silent: with a soft delete available and no filter here,
// `PUT /api/plants/:id {featured_photo_id: <soft-deleted>}` returns 200 and PERSISTS. The read then
// MASKS it by falling back to a different photo with featured_is_explicit: false. The user's choice
// was accepted, stored, and is invisible — verbatim the silent-revert bug the model code documents.
//
// Cross-lambda, so it lives at lambda/ root with the fleet's other enumeration guards
// (authz-write-fk, hero-read-derivation, household-isolation).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct — the fleet convention. Without this, a
// removed filter left behind as `-- was: AND deleted_at IS NULL` satisfies its own guard.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const norm = (s) => s.replace(/\s+/g, ' ').trim();

// Every `linkRows = await sql`...`` template in a handler. That variable name is the fleet's
// consistent spelling for "prove the body-supplied photo id is legitimately attachable here", and it
// is what separates these WRITE validators (id comes from the request body) from the hero READ
// derivations (id comes from the parent row's stored pointer).
function linkRowTemplates(file) {
  const src = decomment(readFileSync(join(here, file), 'utf8'));
  return [...src.matchAll(/linkRows\s*=\s*await\s+sql`([^`]*)`/g)].map((m) => norm(m[1]));
}

// [file, the per-parent membership predicate the validator enforces, a label]
const VALIDATORS = [
  ['plants/index.js', /\(ph\.plant_id = \$\{plantId\} OR e\.plant_id = \$\{plantId\}\)/, 'plants (event-inclusive)'],
  ['projects/index.js', /project_id = \$\{projectId\}/, 'projects'],
  ['locations/index.js', /location_id = \$\{actualLocationId\}/, 'locations'],
  ['inventory-items/index.js', /inventory_item_id = \$\{itemId\}/, 'inventory-items'],
  ['photos/index.js', /space_id = \$\{spaceId\}/, 'photos (space-featured)'],
];

describe('DD3b — set-featured write validators reject soft-deleted photos', () => {
  it('finds every validator (anti-vacuity floor)', () => {
    // Without this the loop below passes trivially the moment the extraction regex or a variable
    // name changes — which is how a guard silently stops guarding.
    const found = VALIDATORS.flatMap(([f]) => linkRowTemplates(f));
    expect(found.length).toBeGreaterThanOrEqual(VALIDATORS.length);
  });

  for (const [file, membershipRe, label] of VALIDATORS) {
    it(`${label} — filters deleted_at, scopes the household, and re-checks membership`, () => {
      const templates = linkRowTemplates(file);
      expect(templates.length, `no linkRows validator found in ${file}`).toBeGreaterThanOrEqual(1);
      const t = templates.find((x) => membershipRe.test(x));
      expect(t, `no linkRows validator in ${file} matching ${membershipRe}`).toBeTruthy();

      // THE GUARD THIS FILE EXISTS FOR. Absent on all four parent validators before W-DEL.
      expect(t, `${label}: set-featured accepts a soft-deleted photo`).toMatch(/deleted_at IS NULL/);
      // Household scope — the SOLE authz control here. RLS is not a floor: photos has RLS enabled
      // but NOT forced, the Lambda connects as neondb_owner (rolbypassrls), and photos_auth_update
      // carries no created_by predicate at all.
      expect(t, `${label}: set-featured is not household-scoped`).toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
      // And it must still read FROM photos — a validator that stopped touching the table would
      // satisfy the two assertions above off some other row entirely.
      expect(t).toMatch(/FROM photos/);
    });
  }

  it('the plants validator stays EVENT-INCLUSIVE — narrowing it would reject 123 of prod\'s 250 plant heroes', () => {
    // EventNew logs event photos with {project_id, event_id} and NO plant_id, so a plant_id-only
    // check rejects roughly half of a planting's gallery. That was V4-PHOTOFEATURE-002 ("Couldn't
    // set featured photo"). It is restated here because the read-side derivation is now pinned to
    // this exact predicate: narrowing either half without the other reintroduces silent-revert.
    const t = linkRowTemplates('plants/index.js').find((x) => /plant_id/.test(x));
    expect(t).toMatch(/LEFT JOIN event_log e ON e\.id = ph\.event_id/);
    expect(t).toMatch(/OR e\.plant_id = \$\{plantId\}/);
  });
});

// V5-SEEDVENDORPHOTOFILTER-001 — supplier packet images are recognised by ONE predicate in two Lambdas:
// the unscoped photo gallery (lambda/photos) and header photo search (lambda/dashboard). Each Lambda is
// zipped from its own directory, so the predicate is written twice; this holds the two spellings equal
// and in the right template. Behaviour against real rows — including the NULL original_filename case the
// COALESCE exists for — is tests/integration/supplier-photo-filter.int.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// photo-access.test.js's decomment: a predicate named only in a comment must not satisfy this.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const src = (rel) => decomment(readFileSync(join(here, rel), 'utf8'));

const PREDICATE = "AND COALESCE(p.original_filename, '') NOT LIKE 'vendor-image--%'";
const count = (s) => s.split(PREDICATE).length - 1;

// The SQL template that holds the predicate: from the backtick that opens it to the one that closes it.
function templateAround(s) {
  const at = s.indexOf(PREDICATE);
  return s.slice(s.lastIndexOf('`', at), s.indexOf('`', at + PREDICATE.length) + 1);
}

describe('supplier-image predicate — one spelling, two Lambdas', () => {
  it('lambda/photos carries it exactly once, in the UNSCOPED gallery template', () => {
    const s = src('photos/index.js');
    expect(count(s)).toBe(1);
    const t = templateAround(s);
    expect(t).toMatch(/FROM photos p/);
    // Not a scoped branch: those read a parent the supplier image does not have, and filtering there
    // would hide nothing while implying it did.
    for (const scoped of ['${attachedTo}', '${locationId}', '${projectId}', '${spaceId}']) {
      expect(t, `the predicate sits in the ${scoped} branch`).not.toContain(scoped);
    }
    expect(t).toMatch(/ORDER BY COALESCE\(p\.taken_at, p\.created_at\) DESC/);
  });

  it('lambda/dashboard searchPhotos carries the identical predicate exactly once', () => {
    const s = src('dashboard/handlers.js');
    expect(count(s)).toBe(1);
    const t = templateAround(s);
    expect(t).toMatch(/FROM photos p/);
    expect(t).toMatch(/p\.caption ILIKE/);
  });

  it('never as a bare NOT LIKE on the column, which drops every photo whose file name is NULL', () => {
    for (const rel of ['photos/index.js', 'dashboard/handlers.js']) {
      expect(src(rel), rel).not.toMatch(/p\.original_filename\s+NOT\s+LIKE/i);
    }
  });
});

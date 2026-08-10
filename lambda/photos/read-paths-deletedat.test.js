// 0A.6 (devops-review plan) — soft-deleted photos must be invisible to every SERVING read path.
// Static-source (L-072), DB-free — same pattern as household-mode.test.js. The three paths named
// in 0A.6 (view-url, project_id list branch, unfiltered list branch) served soft-deleted rows;
// the attachedTo branch already filtered. The enumeration guard closes the class for this
// Lambda's serving SELECTs. EXEMPT by construction: the PUT re-tag `WITH prev` lookup is a
// WRITE-path CTE (feeds an UPDATE, not a response) — tracked separately in the 0A.6 report.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// Real tagged templates only (mirrors lambda/sql-comment-hygiene.test.js extraction).
function sqlTemplates(src) {
  const out = [];
  const re = /(?<![\w`])sql`([^`]*)`/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

describe('photos Lambda — deleted_at filters on serving read paths (0A.6)', () => {
  it('view-url SELECT excludes soft-deleted photos', () => {
    const i = SRC.indexOf('SELECT storage_path FROM photos');
    expect(i).toBeGreaterThan(-1);
    const block = SRC.slice(i, i + 260);
    expect(block).toMatch(/AND deleted_at IS NULL/);
  });

  it('project_id list branch excludes soft-deleted photos', () => {
    const i = SRC.indexOf('} else if (projectId) {');
    expect(i).toBeGreaterThan(-1);
    const block = SRC.slice(i, SRC.indexOf('} else {', i));
    expect(block).toMatch(/AND p\.deleted_at IS NULL/);
  });

  it('unfiltered list branch excludes soft-deleted photos', () => {
    const start = SRC.indexOf('} else {', SRC.indexOf('} else if (projectId) {'));
    expect(start).toBeGreaterThan(-1);
    const block = SRC.slice(start, start + 800);
    expect(block).toMatch(/AND p\.deleted_at IS NULL/);
  });

  it('enumeration (class-closing): EVERY serving SELECT reading FROM photos filters deleted_at', () => {
    const servingReads = sqlTemplates(SRC).filter(
      (t) => /^\s*SELECT/i.test(t) && /FROM photos\b/i.test(t),
    );
    // view-url + attachedTo + project_id + unfiltered = 4 today; a new serving read that
    // forgets the filter fails here, a new one that remembers it just raises the count.
    expect(servingReads.length).toBeGreaterThanOrEqual(4);
    for (const t of servingReads) {
      expect(t, `serving SELECT on photos without deleted_at filter:\n${t}`).toMatch(
        /deleted_at IS NULL/,
      );
    }
  });
});

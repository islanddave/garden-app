// Source text for lambda tests that assert on handler code. Assertions run on decommented text: a
// construct named in a comment is not that construct. The `//` arm keeps `https://` (the `[^:]` guard);
// the `--` arm needs whitespace or line start before it, so a JS decrement is never read as SQL.
// Guarded by ./handlerSource.test.js, which pins both variants to the inline copies they replaced.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAMBDA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// V1: `--` must be followed by whitespace, so a bare `--` line survives.
export const decommentSqlDashSpace = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

// V2: also strips a bare `--` line. A surviving `--` separator hides the CTE declaration after it
// from the column scans (scripts/dev-main-schema-audit.py).
export const decommentSqlDashBare = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

export const HANDLER_SOURCE_SENTINEL = '/*@@ handlerSource: next file @@*/';

// Found in decommented index.js, so a commented-out import does not pull its file in.
const ROUTE_IMPORT = /\b(?:from|import)\s*\(?\s*['"]\.\/([\w-]+Routes\.js)['"]/g;

// A function's index.js plus every ./*Routes.js it imports, in import order, each decommented on its
// own and joined by HANDLER_SOURCE_SENTINEL on its own line, so a whole-handler scan keeps working
// after routes move out of index.js. `decomment` defaults to V2; a test that carried a V1 copy passes
// decommentSqlDashSpace so it keeps seeing the same text (the variants differ on bare `--` lines).
// Order and slice assertions must not use this: an anchor can land in a different file after a split,
// so they read the single file that holds their anchors.
export function readHandlerSource(fn, { decomment = decommentSqlDashBare, root = LAMBDA_DIR } = {}) {
  const dir = resolve(root, fn);
  const index = decomment(readFileSync(resolve(dir, 'index.js'), 'utf8'));
  const routes = [...new Set([...index.matchAll(ROUTE_IMPORT)].map((m) => m[1]))];
  const parts = [index, ...routes.map((r) => decomment(readFileSync(resolve(dir, r), 'utf8')))];
  if (parts.some((p) => p.includes(HANDLER_SOURCE_SENTINEL))) {
    throw new Error(`readHandlerSource(${fn}): a source already contains the sentinel line`);
  }
  return parts.join(`\n${HANDLER_SOURCE_SENTINEL}\n`);
}

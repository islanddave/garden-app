// new-file: new subject, lambda/_test-stubs/handlerSource.js
// Pins the shared decomment variants to the inline copies they replaced, and readHandlerSource's join.
// Trap: the variants differ only on a bare `--`; a corpus without one cannot tell them apart.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decommentSqlDashSpace,
  decommentSqlDashBare,
  readHandlerSource,
  HANDLER_SOURCE_SENTINEL,
} from './handlerSource.js';

// The inline copies, verbatim, as the oracle.
const inlineDashSpace = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const inlineDashBare = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

const CORPUS = [
  'const url = "https://example.com/x"; // trailing note',
  'fetch("http://host/path")',
  '// whole-line comment',
  'SELECT a -- inline sql note',
  '--',
  '  --',
  'WHERE b --x',
  'WHERE c -- x',
  'i--;',
  'n = i-- - 1; // after decrement',
  'x = 1; //',
  'plain line',
].join('\n');

describe('decommentSqlDashSpace (V1: `--` needs whitespace after it)', () => {
  it('matches the inline V1 copy on the corpus', () => {
    expect(decommentSqlDashSpace(CORPUS)).toBe(inlineDashSpace(CORPUS));
  });

  it('keeps a bare `--` line and `--x`, strips `-- x`, keeps `http://` and `i--`', () => {
    expect(decommentSqlDashSpace('--')).toBe('--');
    expect(decommentSqlDashSpace('WHERE b --x')).toBe('WHERE b --x');
    expect(decommentSqlDashSpace('WHERE c -- x')).toBe('WHERE c ');
    expect(decommentSqlDashSpace('fetch("http://host/path") // c')).toBe('fetch("http://host/path") ');
    expect(decommentSqlDashSpace('i--;')).toBe('i--;');
  });
});

describe('decommentSqlDashBare (V2: also strips a bare `--`)', () => {
  it('matches the inline V2 copy on the corpus', () => {
    expect(decommentSqlDashBare(CORPUS)).toBe(inlineDashBare(CORPUS));
  });

  it('strips a bare `--` line, keeps `--x`, strips `-- x`, keeps `http://` and `i--`', () => {
    expect(decommentSqlDashBare('--')).toBe('');
    expect(decommentSqlDashBare('  --')).toBe('  ');
    expect(decommentSqlDashBare('WHERE b --x')).toBe('WHERE b --x');
    expect(decommentSqlDashBare('WHERE c -- x')).toBe('WHERE c ');
    expect(decommentSqlDashBare('fetch("http://host/path") // c')).toBe('fetch("http://host/path") ');
    expect(decommentSqlDashBare('i--;')).toBe('i--;');
  });

  it('differs from V1 on the corpus, so the two pins above are not the same pin', () => {
    expect(decommentSqlDashBare(CORPUS)).not.toBe(decommentSqlDashSpace(CORPUS));
  });
});

describe('readHandlerSource', () => {
  const root = mkdtempSync(join(tmpdir(), 'handler-source-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const fn = (name, files) => {
    mkdirSync(join(root, name));
    for (const [f, body] of Object.entries(files)) writeFileSync(join(root, name, f), body);
    return name;
  };

  // Spliced, so scripts/vitest/vitest-projects.test.js does not read these fixture lines as this file's imports.
  const from = (spec) => `from '${spec}'`;
  const INDEX = [
    `import { handleFoo } ${from('./fooRoutes.js')};`,
    `// import { handleBar } ${from('./barRoutes.js')};`,
    `import { helper } ${from('./helper.js')};`,
    'export const handler = () => handleFoo(); // route',
    '--',
  ].join('\n');
  const FOO = ['export const handleFoo = () => 1; // foo', '  --', 'SELECT 1 -- note'].join('\n');

  it('is index.js decommented (V2) when index.js imports no *Routes.js', () => {
    const name = fn('solo', { 'index.js': 'export const handler = 1; // c\n--\n' });
    expect(readHandlerSource(name, { root })).toBe('export const handler = 1; \n\n');
  });

  it('joins index.js and each imported *Routes.js, decommented separately, with the sentinel line', () => {
    const name = fn('split', { 'index.js': INDEX, 'fooRoutes.js': FOO, 'barRoutes.js': 'BAR', 'helper.js': 'HELPER' });
    expect(readHandlerSource(name, { root })).toBe(
      `${decommentSqlDashBare(INDEX)}\n${HANDLER_SOURCE_SENTINEL}\n${decommentSqlDashBare(FOO)}`,
    );
  });

  it('decomments with the variant passed in: V1 keeps the bare `--` lines V2 strips', () => {
    const name = fn('dash-space', { 'index.js': INDEX, 'fooRoutes.js': FOO });
    expect(readHandlerSource(name, { decomment: decommentSqlDashSpace, root })).toBe(
      `${decommentSqlDashSpace(INDEX)}\n${HANDLER_SOURCE_SENTINEL}\n${decommentSqlDashSpace(FOO)}`,
    );
    expect(readHandlerSource(name, { decomment: decommentSqlDashSpace, root }))
      .not.toBe(readHandlerSource(name, { root }));
  });

  it('throws when a source already contains the sentinel', () => {
    const name = fn('clash', { 'index.js': `x\n${HANDLER_SOURCE_SENTINEL}\n` });
    expect(() => readHandlerSource(name, { root })).toThrow(/sentinel/);
  });
});

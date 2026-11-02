// new-file: new subject, the log lines any caller reaches before sign-in, across every dir that calls the kit
// OPS-LOGINJECTGUARD-001: CloudWatch Text filters match a phrase anywhere in a line, so requester text logged before
// sign-in can trip or hold an alarm. (a) Before requestContext( a handler logs only string literals or logSafe(...).
// (b) The kit's verifyToken catch logs Clerk's message only as the Invalid-form constant. Runtime twins:
// request-context.test.js (the 401 line) and photos/storage-key-guard.test.js (the route line).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const LAMBDA = dirname(fileURLToPath(import.meta.url));
const parse = (src) => acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });

function eachNode(node, fn, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  fn(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) eachNode(c, fn, node); } else if (v && typeof v.type === 'string') eachNode(v, fn, node);
  }
}
const isCallOf = (n, name) => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === name;
const isConsoleCall = (n) => n.type === 'CallExpression' && n.callee.type === 'MemberExpression'
  && n.callee.object.type === 'Identifier' && n.callee.object.name === 'console';
const safeArg = (a) => (a.type === 'Literal' && typeof a.value === 'string')
  || (a.type === 'TemplateLiteral' && a.expressions.length === 0)
  || isCallOf(a, 'logSafe');

describe('log injection: before the kit, a handler logs only literals or logSafe(...) (rule a)', () => {
  const dirs = readdirSync(LAMBDA, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(LAMBDA, d.name, 'index.js')))
    .map((d) => d.name)
    .filter((d) => readFileSync(join(LAMBDA, d, 'index.js'), 'utf8').includes('requestContext('));
  const scans = dirs.map((dir) => {
    const src = readFileSync(join(LAMBDA, dir, 'index.js'), 'utf8');
    const ast = parse(src);
    const from = src.indexOf('export const handler');
    let to = Infinity;
    eachNode(ast, (n) => { if (isCallOf(n, 'requestContext') && n.start > from) to = Math.min(to, n.start); });
    const calls = [];
    eachNode(ast, (n) => { if (isConsoleCall(n) && n.start > from && n.start < to) calls.push(n); });
    return { dir, src, from, to, calls };
  });

  it('found every kit-calling handler, each with a handler export and a kit call after it (anti-vacuity)', () => {
    expect(dirs.length).toBeGreaterThanOrEqual(23);
    expect(scans.filter((s) => s.from < 0 || s.to === Infinity).map((s) => s.dir)).toEqual([]);
    expect(scans.flatMap((s) => s.calls).length).toBeGreaterThanOrEqual(1);
  });

  it('no console argument before requestContext( is anything but a string literal or logSafe(...)', () => {
    const bad = scans.flatMap(({ dir, src, calls }) => calls
      .filter((c) => !c.arguments.every(safeArg))
      .map((c) => `lambda/${dir}/index.js:${c.loc.start.line} ${src.slice(c.start, c.end)}`));
    expect(bad).toEqual([]);
  });
});

describe('log injection: the kit\'s verifyToken catch logs no Clerk text but the Invalid-form constant (rule b)', () => {
  const src = readFileSync(join(LAMBDA, 'request-context.js'), 'utf8');
  const parents = new Map();
  let clause = null;
  eachNode(parse(src), (n, p) => {
    parents.set(n, p);
    if (n.type !== 'TryStatement' || !n.handler) return;
    let callsVerify = false;
    eachNode(n.block, (m) => { if (isCallOf(m, 'verifyToken')) callsVerify = true; });
    if (callsVerify) clause = n.handler;
  });
  const param = clause?.param?.name;

  // err.reason (Clerk's fixed enum) and err.name are allowed; err.message only as an operand of `=== INVALID_FORM`.
  function allowedUse(id) {
    const member = parents.get(id);
    if (member?.type !== 'MemberExpression' || member.object !== id || member.computed) return false;
    if (['reason', 'name'].includes(member.property.name)) return true;
    if (member.property.name !== 'message') return false;
    const operand = parents.get(member)?.type === 'ChainExpression' ? parents.get(member) : member;
    const cmp = parents.get(operand);
    const other = cmp?.left === operand ? cmp?.right : cmp?.left;
    return cmp?.type === 'BinaryExpression' && cmp.operator === '===' && other?.type === 'Identifier' && other.name === 'INVALID_FORM';
  }

  it('found the catch, its error binding and a console call in it (anti-vacuity)', () => {
    expect(param).toBeTruthy();
    const logs = [];
    eachNode(clause.body, (n) => { if (isConsoleCall(n)) logs.push(n); });
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it('every use of the caught error is .reason, .name, or .message compared with INVALID_FORM', () => {
    const bad = [];
    eachNode(clause.body, (n, p) => {
      if (n.type !== 'Identifier' || n.name !== param) return;
      if (p?.type === 'MemberExpression' && p.property === n && !p.computed) return;
      if (!allowedUse(n)) bad.push(`lambda/request-context.js:${n.loc.start.line} ${src.slice((p ?? n).start, (p ?? n).end)}`);
    });
    expect(bad).toEqual([]);
  });
});

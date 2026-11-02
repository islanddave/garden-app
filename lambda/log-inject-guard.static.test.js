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

function analyse(file) {
  const src = readFileSync(file, 'utf8');
  const ast = parse(src);
  const parents = new Map();
  eachNode(ast, (n, p) => parents.set(n, p));
  return { file, src, ast, parents };
}
const rel = (file) => file.slice(LAMBDA.length - 'lambda'.length);
const at = (f, n) => `${rel(f.file)}:${n.loc.start.line} ${f.src.slice(n.start, n.end)}`;
const memberName = (m) => (m.computed ? (m.property.type === 'Literal' ? m.property.value : null) : m.property.name);
const isRef = (n, p) => n.type === 'Identifier'
  && !(p?.type === 'MemberExpression' && p.property === n && !p.computed)
  && !(p?.type === 'Property' && p.key === n && !p.computed && !p.shorthand);
const COMPARISONS = ['===', '!==', '==', '!=', '<', '>', '<=', '>='];

// A way to write output that is not a direct console.<method>(...) call: an alias (const log = console.log,
// console.log.call, (0, console.log)), a global reach (globalThis.console, process.stdout), or a logSafe that is not
// the kit's. Applied to every file the pre-sign-in scan reads, so a sink defined anywhere in it is caught.
function sinkBypasses(f) {
  const bad = [];
  eachNode(f.ast, (n, p) => {
    if (isRef(n, p) && n.name === 'console') {
      const call = f.parents.get(p);
      if (!(p?.type === 'MemberExpression' && p.object === n && call?.type === 'CallExpression' && call.callee === p)) bad.push(at(f, p ?? n));
    }
    if (n.type === 'MemberExpression' && ['console', 'stdout', 'stderr'].includes(memberName(n))) bad.push(at(f, n));
    if (n.type === 'ImportDeclaration' && /^(node:)?(console|process)$/.test(n.source.value)) bad.push(at(f, n));
    if (isRef(n, p) && n.name === 'logSafe') {
      const kitImport = p?.type === 'ImportSpecifier' && p.imported.name === 'logSafe'
        && f.parents.get(p)?.source.value === './request-context.js';
      const kitDecl = p?.type === 'FunctionDeclaration' && p.id === n && f.parents.get(p)?.type === 'ExportNamedDeclaration'
        && f.file.endsWith('/request-context.js');
      const use = (p?.type === 'CallExpression' && p.callee === n) || (p?.type === 'ExportSpecifier' && p.local === n);
      if (!kitImport && !kitDecl && !use) bad.push(at(f, p ?? n));
    }
  });
  return bad;
}

// The top-level function a callee name resolves to in this file, following a relative import into its sibling file.
function resolveFn(f, name, load) {
  for (const stmt of f.ast.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
    if (decl?.type === 'FunctionDeclaration' && decl.id.name === name) return { f, fn: decl, name };
    if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id.type === 'Identifier' && d.id.name === name && /Function/.test(d.init?.type ?? '')) return { f, fn: d.init, name };
      }
    }
    if (stmt.type === 'ImportDeclaration' && stmt.source.value.startsWith('./')) {
      const spec = stmt.specifiers.find((s) => s.type === 'ImportSpecifier' && s.local.name === name);
      if (spec) return resolveFn(load(join(dirname(f.file), stmt.source.value)), spec.imported.name, load);
    }
  }
  return null;
}

// A JSON.stringify({...}) log line is safe when every value is a literal, logSafe(...), or a parameter that every
// in-file caller passes a comparison (http-response.js's `gzip: encoded`).
function safeLogArg(f, fn, a) {
  if (safeArg(a)) return true;
  if (!(a.type === 'CallExpression' && a.callee.type === 'MemberExpression' && a.callee.object.name === 'JSON'
    && memberName(a.callee) === 'stringify' && a.arguments.length === 1 && a.arguments[0].type === 'ObjectExpression')) return false;
  return a.arguments[0].properties.every((prop) => {
    if (prop.type !== 'Property' || prop.computed || prop.shorthand) return false;
    const v = prop.value;
    if (v.type === 'Literal' || isCallOf(v, 'logSafe')) return true;
    const i = fn?.params.findIndex((q) => q.type === 'Identifier' && q.name === v.name);
    const fnName = fn?.id?.name ?? (f.parents.get(fn)?.type === 'VariableDeclarator' ? f.parents.get(fn).id.name : null);
    if (v.type !== 'Identifier' || i < 0 || !fnName) return false;
    const sites = [];
    eachNode(f.ast, (n) => { if (isCallOf(n, fnName)) sites.push(n.arguments[i]); });
    return sites.length > 0 && sites.every((s) => (s?.type === 'BinaryExpression' && COMPARISONS.includes(s.operator))
      || (s?.type === 'Literal' && typeof s.value === 'boolean'));
  });
}

// Scan the code a caller reaches before sign-in: every console call in `inRange` must log only safe arguments, and
// every helper it calls (in this file, or through a relative import) is scanned whole, transitively.
function preAuthScan(f, inRange, load, seen = new Set(), out = { calls: [], helpers: [], bad: [] }) {
  const enclosing = (n) => { let p = f.parents.get(n); while (p && !/Function/.test(p.type)) p = f.parents.get(p); return p; };
  eachNode(f.ast, (n) => {
    if (!inRange(n)) return;
    if (isConsoleCall(n)) {
      out.calls.push(at(f, n));
      if (!n.arguments.every((a) => safeLogArg(f, enclosing(n), a))) out.bad.push(at(f, n));
    }
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && !['requestContext', 'logSafe'].includes(n.callee.name)) {
      const hit = resolveFn(f, n.callee.name, load);
      const key = hit && `${hit.f.file}:${hit.fn.start}`;
      if (hit && !seen.has(key)) {
        seen.add(key);
        out.helpers.push(`${rel(hit.f.file)}:${hit.name}`);
        preAuthScan(hit.f, (m) => m.start >= hit.fn.start && m.end <= hit.fn.end, load, seen, out);
      }
    }
  });
  return out;
}

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

describe('log injection: no way around rule (a) through an alias, a helper or the kit\'s own pre-verify code', () => {
  const cache = new Map();
  const load = (file) => { if (!cache.has(file)) cache.set(file, analyse(file)); return cache.get(file); };
  const handlers = readdirSync(LAMBDA, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(LAMBDA, d.name, 'index.js')))
    .map((d) => load(join(LAMBDA, d.name, 'index.js')))
    .filter((f) => f.src.includes('requestContext('));
  const kit = load(join(LAMBDA, 'request-context.js'));
  const responder = load(join(LAMBDA, 'http-response.js'));
  const pre = handlers.map((f) => {
    const from = f.src.indexOf('export const handler');
    let to = Infinity;
    eachNode(f.ast, (n) => { if (isCallOf(n, 'requestContext') && n.start > from) to = Math.min(to, n.start); });
    return preAuthScan(f, (n) => n.start > from && n.start < to, load);
  });
  let kitFn = null;
  let verifyTry = null;
  eachNode(kit.ast, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id.name === 'requestContext') kitFn = n;
    if (n.type === 'TryStatement' && kitFn && n.start > kitFn.start && !verifyTry) {
      eachNode(n.block, (m) => { if (isCallOf(m, 'verifyToken')) verifyTry = n; });
    }
  });
  const kitPre = kitFn && verifyTry && preAuthScan(kit, (n) => n.start > kitFn.start && n.start < verifyTry.start, load);
  const kitPreText = kitFn && verifyTry ? kit.src.slice(kitFn.start, verifyTry.start) : '';
  const responderScan = preAuthScan(responder, () => true, load);

  it('found the handler helpers, the kit before verifyToken and http-response.js\'s log line (anti-vacuity, OPS-LOGINJECTGUARD-001)', () => {
    expect(handlers.length).toBeGreaterThanOrEqual(23);
    expect(pre.flatMap((s) => s.helpers)).toEqual(expect.arrayContaining(['lambda/plants/http-response.js:jsonResponder']));
    expect(pre.flatMap((s) => s.calls).filter((c) => c.includes('http-response.js:')).length).toBeGreaterThanOrEqual(1);
    expect(kitPreText).toContain('getSecrets(');
    expect(kitPreText).toContain('const authHeader');
    expect(responderScan.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('every file the scan reads writes output only as a direct console.<method>(...) call, with the kit\'s logSafe (OPS-LOGINJECTGUARD-001)', () => {
    const files = [...handlers, kit, responder, ...cache.values()];
    expect([...new Set(files)].flatMap(sinkBypasses)).toEqual([]);
  });

  it('what a handler runs before the kit, its helpers included, logs only literals, logSafe(...) or a comparison (OPS-LOGINJECTGUARD-001)', () => {
    expect(pre.flatMap((s) => s.bad)).toEqual([]);
  });

  it('the kit logs nothing from the request before verifyToken, and http-response.js logs ae only through logSafe (OPS-LOGINJECTGUARD-001)', () => {
    expect(kitPre.bad).toEqual([]);
    expect(responderScan.bad).toEqual([]);
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

  // The catch can reach the token, the headers and the event; naming any of them is how a value gets in.
  it('the catch logs with console.error only, from its own consts, and names nothing but the error, INVALID_FORM and resp (OPS-LOGINJECTGUARD-001)', () => {
    const locals = new Set([param]);
    eachNode(clause.body, (n) => { if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') locals.add(n.id.name); });
    const allowed = new Set([...locals, 'INVALID_FORM', 'console', 'resp']);
    const bad = [];
    eachNode(clause.body, (n, p) => {
      const line = `lambda/request-context.js:${n.loc.start.line} ${src.slice(n.start, n.end)}`;
      if (isConsoleCall(n)) {
        if (memberName(n.callee) !== 'error') bad.push(line);
        for (const a of n.arguments) {
          if (!(a.type === 'Literal' && typeof a.value === 'string') && !(a.type === 'Identifier' && locals.has(a.name) && a.name !== param)) bad.push(line);
        }
      }
      if (isRef(n, p) && !(p?.type === 'VariableDeclarator' && p.id === n) && !allowed.has(n.name)) bad.push(line);
    });
    expect(bad).toEqual([]);
  });
});

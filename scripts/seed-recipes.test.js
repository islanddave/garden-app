// scripts/seed-recipes.mjs — the Put-Up release 4 recipe seed. What this proves without a database: the argument
// and environment refusals (a URL is never taken or printed); the seed file's two shapes; how an item becomes the
// POST /api/recipes body (container text, listed heat, the route's own rules — a refused item writes nothing);
// that the body the script sends is accepted by the REAL handleRecipeRoute (mock driver); and that main() is a dry
// run unless --i-mean-it, skips names the user already has, find-or-creates types, and writes only through the
// handler, as the --user, with a key derived from (user, name). What it cannot: that the SQL runs — the
// integration file tests/integration/recipes-routes.int.test.js and the local rehearsal do that.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRecipeRoute } from '../lambda/preservation/recipeRoutes.js';
import {
  parseArgs, recipesOf, parseContainerText, shuOf, seedKey, planRecipe, main, ENV_KEY,
} from './seed-recipes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(here, 'seed-recipes.fixture.json'), 'utf8');
const USER = 'user_2abcDave';
const JEN = 'user_2abcJen';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENV = { [ENV_KEY]: 'postgresql://owner:hunter2@ep-seed-123.neon.tech/neondb', GARDEN_HOUSEHOLD_IDS: `${USER},${JEN}` };

afterEach(() => vi.restoreAllMocks());

describe('parseArgs — dry run unless --i-mean-it; the user and file by flag; never a URL', () => {
  it('reads both spellings and defaults to a dry run', () => {
    expect(parseArgs(['--user', USER, '--file', 'x.json'])).toEqual({ user: USER, file: 'x.json', write: false });
    expect(parseArgs([`--user=${USER}`, '--file=x.json', '--i-mean-it'])).toEqual({ user: USER, file: 'x.json', write: true });
    expect(parseArgs(['--help'])).toEqual({ help: true });
  });

  it('refuses a missing user or file, a bad user id and an unknown flag', () => {
    expect(parseArgs(['--file', 'x.json']).error).toMatch(/--user/);
    expect(parseArgs(['--user', USER]).error).toMatch(/--file/);
    expect(parseArgs(['--user', 'no spaces allowed', '--file', 'x']).error).toMatch(/Clerk user id/);
    expect(parseArgs(['--user', '--file', 'x']).error).toMatch(/--user needs a value/);
    expect(parseArgs(['--user', USER, '--file', 'x', '--i-mean-t']).error).toBe('unknown flag: --i-mean-t');
  });

  it('refuses a connection string anywhere on the command line without echoing it', () => {
    for (const a of ['postgresql://u:hunter2@ep-x.neon.tech/db', 'u:hunter2@host']) {
      const { error } = parseArgs(['--user', USER, '--file', 'x', a]);
      expect(error).toMatch(/looks like a connection string/);
      expect(error).not.toMatch(/hunter2|neon\.tech/);
    }
  });
});

describe('the seed file and its items', () => {
  it('takes an array, or the review file\'s {recipes: [...]}', () => {
    expect(recipesOf([1])).toEqual([1]);
    expect(recipesOf({ source: 'x', recipes: [2] })).toEqual([2]);
    expect(recipesOf({ nope: [] })).toBeNull();
  });

  it('container text: size and unit only where unambiguous (a bare "oz" beside a container noun is fluid)', () => {
    expect(parseContainerText('16 oz jar')).toEqual({ label: '16 oz jar', size: '16', unit: 'fl oz' });
    expect(parseContainerText('one 8 oz woozy bottle')).toEqual({ label: 'one 8 oz woozy bottle', size: '8', unit: 'fl oz' });
    expect(parseContainerText('quart jar')).toEqual({ label: 'quart jar', size: '1', unit: 'qt' });
    expect(parseContainerText('500 ml bottle')).toMatchObject({ size: '500', unit: 'ml' });
    expect(parseContainerText('8 oz')).toEqual({ label: '8 oz', size: null, unit: null });
    expect(parseContainerText('the big crock')).toEqual({ label: 'the big crock', size: null, unit: null });
    expect(parseContainerText('  ')).toBeNull();
  });

  it('listed heat: a number, a pair, an object or "4,000–8,000"', () => {
    expect(shuOf(null)).toBeNull();
    expect(shuOf(2500)).toEqual({ low: 2500, high: 2500 });
    expect(shuOf([2500, 8000])).toEqual({ low: 2500, high: 8000 });
    expect(shuOf({ low: 30000, high: 50000 })).toEqual({ low: 30000, high: 50000 });
    expect(shuOf('4,000–8,000')).toEqual({ low: 4000, high: 8000 });
    expect(shuOf('hot').error).toBeTruthy();
  });

  it('a key per (user, name): the same for a rerun, different per user or name, a v4 uuid', () => {
    expect(seedKey(USER, 'Mojo')).toMatch(UUID);
    expect(seedKey(USER, ' mojo ')).toBe(seedKey(USER, 'Mojo'));
    expect(seedKey(JEN, 'Mojo')).not.toBe(seedKey(USER, 'Mojo'));
    expect(seedKey(USER, 'Mojo 2')).not.toBe(seedKey(USER, 'Mojo'));
  });

  it('the fixture\'s two items become valid bodies: type, containers, lines as written, heat, at the end', () => {
    const [a, b] = JSON.parse(FIXTURE).map((it) => planRecipe(it, USER));
    expect(a.error).toBeUndefined();
    expect(a.type).toBe('Hot sauce');
    expect(a.body).toMatchObject({ name: 'Roll for Initiative', kind: 'other', keeps: { n: 7, unit: 'day', storage_kind: 'fridge' },
      bottle_label: 'one 8 oz woozy bottle', bottle_size: '8', bottle_unit: 'fl oz' });
    expect(a.body).not.toHaveProperty('vessel_label');
    expect(a.body).not.toHaveProperty('link_url');
    expect(a.body.lines[2]).toEqual({ ordinal: 3, name: 'cumin', amount_text: 'pinch of cumin' });
    expect(a.body.idempotency_key).toBe(seedKey(USER, 'Roll for Initiative'));
    expect(b.type).toBe('Wing glaze');
    expect(b.body).toMatchObject({ vessel_label: '16 oz jar', vessel_size: '16', vessel_unit: 'fl oz', link_url: 'https://example.com/petri-dish' });
    expect(b.body.lines[0]).toMatchObject({ brand: 'Taekyung', form: 'dried', shu_rating_low: 4000, shu_rating_high: 8000 });
    expect(b.body.lines[1]).toMatchObject({ role: 'water' });
    expect(b.body.lines[1]).not.toHaveProperty('form');
    expect(b.body.lines[2]).toMatchObject({ at_the_end: true });
  });

  it('an item the route would refuse is refused here, with the route\'s words', () => {
    const bad = JSON.parse(FIXTURE)[0];
    expect(planRecipe({ ...bad, link_url: 'javascript:alert(1)' }, USER).error).toMatch(/http/);
    expect(planRecipe({ ...bad, keeps: { n: 7, unit: 'day' } }, USER).error).toMatch(/storage_kind/);
    expect(planRecipe({ ...bad, name: ' ' }, USER).error).toMatch(/name/);
    expect(planRecipe({ ...bad, lines: [{ name: 'salt', qty: 5, qty_unit: 'g', salt_pct: 3 }] }, USER).error).toMatch(/salt/);
  });

  it('the body the script sends is accepted by the REAL handleRecipeRoute (one INSERT, the user the owner)', async () => {
    const { body } = planRecipe(JSON.parse(FIXTURE)[1], USER);
    const calls = [];
    const sql = (strings, ...values) => {
      calls.push({ text: strings.join('?'), values });
      const q = [[{ id: 'r-1', line_count: 3 }], [{ id: 'r-1', name: body.name }], [], []];
      return Promise.resolve(q[calls.length - 1] ?? []);
    };
    const res = await handleRecipeRoute({ sql, rawPath: '/api/recipes', method: 'POST', rawBody: JSON.stringify(body), query: {}, userId: USER, householdIds: [USER, JEN] });
    expect(res.status).toBe(201);
    expect(calls[0].text).toMatch(/INSERT INTO recipe \(/);
    expect(calls[0].values[0]).toBe(USER);
    expect(calls[0].values).toContain(seedKey(USER, 'Petri Dish Pioneer'));
  });
});

// A scripted handler standing in for lambda/preservation/index.js: records every request and answers like the route.
function fakeHandler({ existing = [], types = [{ id: 't-hot', label: 'Hot sauce', builtin: true }] } = {}) {
  const stubState = { verifyTokenResult: null };
  const requests = [];
  const handler = async (event) => {
    const req = { method: event.requestContext.http.method, path: event.rawPath, as: stubState.verifyTokenResult?.sub,
      body: event.body ? JSON.parse(event.body) : null };
    requests.push(req);
    const r = (statusCode, b) => ({ statusCode, body: JSON.stringify(b) });
    if (req.method === 'GET' && req.path === '/api/recipes') return r(200, { recipes: existing });
    if (req.method === 'GET' && req.path === '/api/recipes/types') return r(200, { types });
    if (req.method === 'POST' && req.path === '/api/recipes/types') return r(201, { type: { id: 't-new', label: req.body.label, builtin: false }, created: true });
    if (req.method === 'POST' && req.path === '/api/recipes') return r(201, { recipe: { id: `r-${requests.length}`, name: req.body.name, lines: req.body.lines ?? [] } });
    return r(404, {});
  };
  return { requests, loadHandler: async () => ({ handler, stubState }) };
}
const run = (argv, deps, env = ENV) => main(argv, env, { readFile: () => FIXTURE, ...deps });
const quiet = () => { const log = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); return log; };

describe('main — dry run by default; writes only through the handler, as the user', () => {
  it('refuses without the URL, with a bad URL, or with a household that does not hold the user — printing no URL', async () => {
    const log = quiet();
    const err = console.error;
    expect(await run(['--user', USER, '--file', 'f.json'], {}, {})).toBe(1);
    expect(await run(['--user', USER, '--file', 'f.json'], {}, { [ENV_KEY]: 'not a url', GARDEN_HOUSEHOLD_IDS: USER })).toBe(1);
    expect(await run(['--user', USER, '--file', 'f.json'], {}, { ...ENV, GARDEN_HOUSEHOLD_IDS: JEN })).toBe(1);
    const printed = [...log.mock.calls, ...err.mock.calls].flat().join('\n');
    expect(printed).not.toMatch(/hunter2|owner:/);
  });

  it('a dry run reads (GET) and prints the plan; it POSTs nothing; the target shows host and db only', async () => {
    const log = quiet();
    const f = fakeHandler();
    expect(await run(['--user', USER, '--file', 'f.json'], { loadHandler: f.loadHandler })).toBe(0);
    expect(f.requests.map((r) => r.method)).toEqual(['GET', 'GET']);
    expect(f.requests.every((r) => r.as === USER)).toBe(true);
    const out = log.mock.calls.flat().join('\n');
    expect(out).toMatch(/DRY RUN · target ep-seed-123\.neon\.tech\/neondb/);
    expect(out).toMatch(/built-in type "Hot sauce"/);
    expect(out).toMatch(/NEW type "Wing glaze"/);
    expect(out).toMatch(/2 recipe\(s\) would be created/);
    expect(out).not.toMatch(/hunter2/);
  });

  it('--i-mean-it: a new type is found-or-created, each recipe POSTed once as the user, with its type and key', async () => {
    quiet();
    const f = fakeHandler();
    expect(await run(['--user', USER, '--file', 'f.json', '--i-mean-it'], { loadHandler: f.loadHandler })).toBe(0);
    const posts = f.requests.filter((r) => r.method === 'POST');
    expect(posts.map((r) => r.path)).toEqual(['/api/recipes', '/api/recipes/types', '/api/recipes']);
    expect(posts.every((r) => r.as === USER)).toBe(true);
    expect(posts[0].body).toMatchObject({ name: 'Roll for Initiative', recipe_type_id: 't-hot', idempotency_key: seedKey(USER, 'Roll for Initiative') });
    expect(posts[1].body).toEqual({ label: 'Wing glaze' });
    expect(posts[2].body).toMatchObject({ name: 'Petri Dish Pioneer', recipe_type_id: 't-new' });
  });

  it('idempotent: a name the user already has is skipped (another household member\'s is not the user\'s)', async () => {
    const log = quiet();
    const f = fakeHandler({ existing: [
      { id: 'x', user_id: USER, name: '  roll FOR initiative ' },
      { id: 'y', user_id: JEN, name: 'Petri Dish Pioneer' },
    ] });
    expect(await run(['--user', USER, '--file', 'f.json', '--i-mean-it'], { loadHandler: f.loadHandler })).toBe(0);
    const posts = f.requests.filter((r) => r.method === 'POST' && r.path === '/api/recipes');
    expect(posts.map((r) => r.body.name)).toEqual(['Petri Dish Pioneer']);
    expect(log.mock.calls.flat().join('\n')).toMatch(/already has a recipe named this/);
  });

  it('every recipe already there → nothing to do, nothing written', async () => {
    const log = quiet();
    const f = fakeHandler({ existing: [{ user_id: USER, name: 'Roll for Initiative' }, { user_id: USER, name: 'Petri Dish Pioneer' }] });
    expect(await run(['--user', USER, '--file', 'f.json', '--i-mean-it'], { loadHandler: f.loadHandler })).toBe(0);
    expect(f.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    expect(log.mock.calls.flat().join('\n')).toMatch(/Nothing to do/);
  });

  it('a file with one refused item writes NOTHING (exit 2), even with --i-mean-it', async () => {
    quiet();
    const f = fakeHandler();
    const items = JSON.parse(FIXTURE);
    items[1].link_url = 'ftp://example.com/x';
    const code = await main(['--user', USER, '--file', 'f.json', '--i-mean-it'], ENV, { readFile: () => JSON.stringify({ recipes: items }), loadHandler: f.loadHandler });
    expect(code).toBe(2);
    expect(f.requests).toHaveLength(0);
  });

  it('a failed POST is exit 3 and says a re-run skips what landed', async () => {
    const log = quiet();
    const f = fakeHandler();
    const loadHandler = async () => {
      const h = await f.loadHandler();
      return { ...h, handler: async (e) => (e.rawPath === '/api/recipes' && e.requestContext.http.method === 'POST'
        ? { statusCode: 400, body: JSON.stringify({ error: 'nope' }) } : h.handler(e)) };
    };
    expect(await run(['--user', USER, '--file', 'f.json', '--i-mean-it'], { loadHandler })).toBe(3);
    expect(log.mock.calls.flat().join('\n')).toMatch(/re-run skips/);
  });
});

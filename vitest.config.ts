import { fileURLToPath } from 'node:url';
import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import TestIdsReporter from './scripts/vitest/vitest-test-ids-reporter.mjs';
import { nodeProjectFiles } from './scripts/vitest/vitest-node-project.mjs';

// The two projects of the unit run (see `test` below). `node` takes the test files whose code under test is
// server-side: those under lambda/, scripts/, migrations/ and tests/parity/ that load nothing under src/. Which
// files those are, and why they reach vitest as one list of files and not as globs, is
// scripts/vitest/vitest-node-project.mjs. The list is the node project's `include` and the dom project's
// `exclude`, so dom takes every other file, wherever it lives. The walk runs on every load of this config, so the
// directory is a path (fileURLToPath), not a URL's pathname, which would keep a space in the checkout path as %20.
const twoProjects = () => {
  const nodeFiles = nodeProjectFiles(fileURLToPath(new URL('.', import.meta.url)));
  return [
    { extends: true, test: { name: 'dom', environment: 'jsdom', setupFiles: ['./src/__tests__/setup.ts'], exclude: nodeFiles } },
    { extends: true, test: { name: 'node', environment: 'node', include: nodeFiles } },
  ];
};

export default defineConfig({
  plugins: [react()],
  // Belt-and-braces, not load-bearing: under vitest 4 the unit run transforms modules under the top-level vite,
  // which the plugin above supports, so the automatic JSX runtime reaches it either way and
  // src/__tests__/jsxAutomaticRuntime.test.jsx stays green without this line. If a vitest upgrade ever transforms
  // under a vite the plugin does not support, esbuild falls back to the classic runtime and every .jsx that does
  // not `import React` throws `React is not defined` when a test renders it; this line is then the fix.
  // Unit run only: the production bundle is built from vite.config.js.
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  // Lambda runtime deps, aliased to the stubs in lambda/_test-stubs so the unit run can import and execute
  // handlers: each Lambda declares its AWS/Clerk/Neon deps in its own package.json and none is installed at the
  // repo root. Safe because no src/ file imports any of these specifiers. Never add a Lambda dep to the ROOT
  // package.json: it would shadow this. The integration suite (vitest.integration.config.ts) uses the real driver.
  resolve: {
    alias: {
      '@clerk/backend': new URL('./lambda/_test-stubs/clerk-backend.js', import.meta.url).pathname,
      '@neondatabase/serverless': new URL('./lambda/_test-stubs/neon-serverless.js', import.meta.url).pathname,
      '@aws-sdk/client-secrets-manager': new URL('./lambda/_test-stubs/aws-secrets.js', import.meta.url).pathname,
      '@aws-sdk/client-s3': new URL('./lambda/_test-stubs/aws-s3.js', import.meta.url).pathname,
      '@aws-sdk/s3-request-presigner': new URL('./lambda/_test-stubs/s3-presigner.js', import.meta.url).pathname,
      // Reached only through a dynamic `await import()` in photo-access.js, which does NOT exempt it: vite
      // resolves dynamic specifiers at transform time, so without this every handler importing photo-access.js
      // fails to collect.
      '@aws-sdk/cloudfront-signer': new URL('./lambda/_test-stubs/cloudfront-signer.js', import.meta.url).pathname,
    },
  },
  test: {
    globals: true,
    // TWO PROJECTS in every run (twoProjects, above). A local run and ci.yml run this one shape;
    // scripts/vitest/vitest-projects.test.js holds the projects to the tree.
    // `environment` and `setupFiles` live INSIDE the projects, never beside them: a project with `extends: true`
    // inherits this whole block and arrays concatenate, so a `setupFiles` out here would also load in the node
    // project, where src/__tests__/setup.ts reads `document` in an afterEach and every test fails. The same
    // concatenation makes the dom project's `exclude` ADD to the list further down. Everything else stays out
    // here and reaches both projects. Coverage is one merged report from this block's `coverage`.
    // `--dir` on the command line does not reach a project, so `vitest run --dir src/__tests__` collects every
    // file; name the files or a filter instead. Configs that build on this one hand `--dir` on:
    // scripts/vitest/vitest-side-config.mjs.
    projects: twoProjects(),
    // The test-ids notice (scripts/vitest/vitest-test-ids-reporter.mjs): on a GitHub Actions runner each run ends
    // with one ::notice carrying digests of its sorted test files and test IDs. ci.yml's coverage merge reads it
    // to prove the three shards ran the suite's files, each once, and reds with no notice. Setting `reporters`
    // replaces vitest's own default, so the first two entries restate it; vitest-test-ids-reporter.test.js asks
    // the installed vitest for that default and reds when they differ. The reporter is imported above
    // unconditionally so a broken one fails a local run too, not only CI.
    ...(process.env.GITHUB_ACTIONS === 'true'
      ? { reporters: ['default', 'github-actions', new TestIdsReporter()] }
      : {}),
    // Must stay ABOVE the asyncUtilTimeout set in setup.ts (5000): otherwise vitest kills the test before waitFor
    // can report WHICH element it could not find. The headroom is for several sequential waitFors. A ceiling,
    // not a duration: a passing test finishes when it finishes.
    testTimeout: 20000,
    // Integration tests (tests/integration/**) run in the integration-tests workflow via
    // vitest.integration.config.ts (real Neon driver + DB). Exclude them from the unit run
    // so `npm test` doesn't try to resolve @neondatabase/serverless.
    // '**/.claude/**': agent worktrees under .claude/worktrees/ hold full copies of the repo, which a bare
    // `vitest run` would otherwise collect. CI runners never have these directories.
    exclude: [...configDefaults.exclude, 'tests/integration/**', '**/.claude/**'],
    // Stub VITE_ env vars for tests — real values not needed in unit tests
    env: {
      VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_unit_test_placeholder',
      VITE_API_PROJECTS:          'https://test-placeholder.lambda-url.us-east-1.on.aws/',
      VITE_API_PLANTS:            'https://test-placeholder.lambda-url.us-east-1.on.aws/',
      VITE_API_LOCATIONS:         'https://test-placeholder.lambda-url.us-east-1.on.aws/',
      VITE_API_EVENTS:            'https://test-placeholder.lambda-url.us-east-1.on.aws/',
      VITE_API_FAVORITES:         'https://test-placeholder.lambda-url.us-east-1.on.aws/',
      VITE_API_PHOTOS:            'https://test-placeholder.lambda-url.us-east-1.on.aws/',
      VITE_API_DASHBOARD:         'https://test-placeholder.lambda-url.us-east-1.on.aws/',
      VITE_API_INVENTORY:         'https://test-placeholder.lambda-url.us-east-1.on.aws/',
      VITE_API_VARIETIES:         'https://test-placeholder.lambda-url.us-east-1.on.aws/',
    },
    coverage: {
      // Still v8 coverage: the module named here subclasses the installed @vitest/coverage-v8 and changes one
      // thing. A module under lambda/daily-plan/ reaches V8 in two forms under one URL: vite's text of it, in a
      // test file that imports it, and the file's own text, wherever handler.js or a createRequire loads it. The
      // stock provider keeps one start offset per URL and converts both forms against vite's text, so its totals
      // move from run to run and it can leave negative hit counts. The module converts each form against the text
      // it was compiled from, and fails the run on a negative hit count or on a file whose two conversions are
      // not one list. It leans on vitest internals: its header lists them and
      // scripts/vitest/coverage-v8-two-forms.test.js holds them to the installed package (and holds these two
      // lines). Re-read both on a vitest or @vitest/coverage-v8 upgrade. The stock provider reads about a point
      // lower on branches, so a threshold or active_target set above its figure makes taking the module out a red
      // gate. How to take it out: scripts/vitest/README.md.
      provider: 'custom',
      customProviderModule: './scripts/vitest/coverage-v8-two-forms.mjs',
      reporter: ['text', 'json-summary', 'lcov', 'html'],
      reportsDirectory: './coverage',
      thresholds: {
        // Anti-regression floor, set below the measured coverage of the `include` set so normal churn passes
        // but gutting the tests reds CI. Enforced two ways: vitest fails `npm test` below these, and
        // scripts/check-coverage-ratchet.py reads these four lines (each key starts its own line) and fails
        // when they, or the lowest measured metric, sit below coverage-ratchet.json active_target. Raising the
        // floor is a milestone decision: raise these in lockstep with active_target.
        // ci.yml's coverage shards (plan A4) set these four keys to 0 on the command line, so a third of the suite
        // checks nothing; the merge checks them. A key added here (a glob, perFile, 100, autoUpdate) would reach every
        // shard: add its neutral form to the shards' command too (ci.yml, and COV_PASS_RUN in scripts/test_ci_legs.py).
        lines:      82,
        functions:  80,
        branches:   80,
        statements: 82,
      },
      include: [
        'src/lib/**',
        'src/hooks/**',
        'src/components/**',
        'src/context/**',
        // The entries below add measurement, not a gate: a file outside this list can lose its tests without
        // moving a CI number. Adding one never moves the floor or active_target.
        'lambda/daily-plan/**',
        'lambda/harvests/**',
        // Executable here only through the stub aliases above. household.js reads low on functions (a shared
        // module whose other exports this path does not reach); keep it in rather than exclude it for the figure.
        'lambda/facebook-share/**',
        // One page, not src/pages/**: the page whose VoiceHarvest.*.test.jsx files this measures.
        'src/pages/VoiceHarvest.jsx',
      ],
      exclude: [
        'src/__tests__/**',
        'src/main.jsx',
        'src/shims/**',
        '**/*.d.ts',
        // Colocated lambda test files must not count as covered source (this custom exclude list
        // replaces vitest's defaults, which would otherwise have excluded them).
        'lambda/**/*.test.js',
      ],
    },
  },
});

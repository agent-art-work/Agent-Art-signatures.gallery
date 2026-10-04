import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnvironment, coverageRatchetFromConfig, execute, runCiEvidence, summarizeCoverage, summarizePreviewTests,
  summarizeVitest } from '../../scripts/ci-test-evidence.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const source = async () => ({ commit: 'a'.repeat(40), tree: 'b'.repeat(40), worktreeClean: true,
  trackedInputInventorySha256: 'c'.repeat(64), trackedInputFiles: 1, trackedDiffSha256: 'd'.repeat(64) });
const tests = { numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0,
  numTotalTests: 2, numPassedTests: 1, numFailedTests: 0, numPendingTests: 1, numTodoTests: 0, success: true,
  testResults: [{ name: '/private/fixture-path', failureMessage: 'SECRET-NOT-RETAINED' }] };
const coverage = { total: Object.fromEntries(['lines', 'statements', 'functions', 'branches'].map(metric =>
  [metric, { total: 100, covered: 98, skipped: 0, pct: 98 }])), '/private/fixture-source': { secrets: 'NOT-RETAINED' } };
const packagingOutput = `Tests  251 passed (251)\n${['staging', 'production'].flatMap(environment => [
  `${environment} manifest exactly inventories a deterministic public preview package`,
  `${environment} contains no backend, native renderer, secret or network-capable browser module`,
  `${environment} packaged Worker and assets execute inside real Cloudflare workerd`,
]).map((name, index) => `ok ${index + 1} - ${name}`).join('\n')}
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
Raw arbitrary log: SECRET-NOT-RETAINED`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sg-ci-evidence-tests-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, outputDir: join(directory, 'evidence') };
}
async function coverageFiles(command) {
  const report = command.find(value => value.startsWith('--outputFile=')).slice('--outputFile='.length);
  const directory = command.find(value => value.startsWith('--coverage.reportsDirectory=')).slice('--coverage.reportsDirectory='.length);
  await mkdir(directory, { recursive: true });
  await writeFile(report, JSON.stringify(tests));
  await writeFile(join(directory, 'coverage-summary.json'), JSON.stringify(coverage));
}
async function packageFiles(command) {
  const environment = command[4], directory = command.at(-1), worker = 'export default { fetch() {} };';
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'worker.mjs'), worker);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    schema: 'signatures-gallery.preview-cloudflare.v1', environment,
    artifactSha256: digest(worker), files: [{ path: 'worker.mjs', bytes: Buffer.byteLength(worker), sha256: digest(worker) }],
  }));
}

test('only explicit environment opt-ins and empty credentials reach a child', () => {
  const environment = { PATH: '/safe/bin', HOME: '/existing-home', OPEN_MINT_TEST_HTTP: '1', OPEN_MINT_TEST_POSTGRES: '1',
    OPEN_MINT_TEST_POSTGRES_BIN: '/isolated/bin', XAI_API_KEY: 'SECRET', GITHUB_TOKEN: 'SECRET',
    DATABASE_URL: 'SECRET', PRIVATE_KEY: 'SECRET', CLOUDFLARE_API_TOKEN: 'SECRET' };
  const core = childEnvironment(environment, 'coverage');
  assert.equal(core.OPEN_MINT_TEST_POSTGRES, '1'); assert.equal(core.OPEN_MINT_TEST_HTTP, '1');
  assert.equal(core.XAI_API_KEY, ''); assert.equal(core.CLOUDFLARE_API_TOKEN, '');
  for (const key of ['GITHUB_TOKEN', 'DATABASE_URL', 'PRIVATE_KEY']) assert.equal(core[key], undefined);
  const preview = childEnvironment(environment, 'preview');
  assert.equal(preview.OPEN_MINT_TEST_HTTP, ''); assert.equal(preview.OPEN_MINT_TEST_POSTGRES, '');
  assert.doesNotMatch(JSON.stringify(core), /SECRET/);
});

test('numeric summaries discard raw test names, failure payloads and source paths', () => {
  assert.equal(summarizeVitest(tests).numPendingTests, 1);
  assert.deepEqual(summarizeCoverage(coverage).total, coverage.total);
  assert.doesNotMatch(JSON.stringify([summarizeVitest(tests), summarizeCoverage(coverage)]), /SECRET|private|fixture-source/);
  for (const malformed of [{}, { ...tests, numTotalTests: 0 }, { ...tests, numFailedTests: NaN }]) {
    assert.throws(() => summarizeVitest(malformed));
  }
  assert.throws(() => summarizeCoverage({ total: { lines: {} } }));
});

test('the receipt profile matches the unchanged global ratchet without adding a line threshold', async () => {
  const config = await readFile(new URL('../../vitest.config.ts', import.meta.url), 'utf8');
  assert.deepEqual(coverageRatchetFromConfig(config), { statements: 93, branches: 87, functions: 97 });
  assert.throws(() => coverageRatchetFromConfig(config.replace('statements: 93', 'statements: 92')), /ratchet differs/);
  assert.throws(() => coverageRatchetFromConfig(config.replace('functions: 97', 'functions: 97, lines: 93')), /ratchet differs/);
});

test('preview summary requires both real workerd and manifest/security cases, not a generic success flag', () => {
  const summary = summarizePreviewTests(packagingOutput);
  assert.equal(summary.requiredCases.length, 6); assert.equal(summary.unit.passed, 251);
  assert.doesNotMatch(JSON.stringify(summary), /SECRET|Raw arbitrary/);
  assert.throws(() => summarizePreviewTests(packagingOutput.replace('ok 6 - ', 'not ok 6 - ')), /Required preview/);
  assert.throws(() => summarizePreviewTests('success: true'), /Missing Node test/);
});

test('real child execution preserves nonzero CLI status and signal instead of a reported-success flag', async () => {
  const result = await execute([process.execPath, '-e', 'process.exitCode = 7'], {
    repository: process.cwd(), environment: childEnvironment(process.env, 'preview'),
  });
  assert.equal(result.code, 7); assert.equal(result.signal, null); assert.equal(result.spawnError, false);
});

for (const code of [0, 1, 7]) {
  test(`coverage CLI exit ${code} is retained independently of JSON success`, async t => {
    const { outputDir } = await fixture(t);
    const exit = await runCiEvidence({ profile: 'coverage', outputDir, source,
      environment: { OPEN_MINT_TEST_HTTP: '1', OPEN_MINT_TEST_POSTGRES: '1' }, run: async command => {
        await coverageFiles(command); return { code, signal: null, durationMs: 1, output: 'SECRET-NOT-RETAINED' };
      } });
    assert.equal(exit, code);
    const receipt = JSON.parse(await readFile(join(outputDir, 'execution.json'), 'utf8'));
    assert.equal(receipt.exitCode, code); assert.equal(receipt.commands[0].cliExitCode, code);
    assert.equal(receipt.tests.reportedSuccess, true); assert.equal(receipt.tests.numPendingTests, 1);
    assert.deepEqual(receipt.optIns, { http: true, postgres: true });
    assert.equal(receipt.commands[0].argv[2], 'test:coverage');
    assert.deepEqual((await readdir(outputDir)).sort(), ['coverage-summary.json', 'execution.json', 'test-summary.json']);
    for (const path of await readdir(outputDir)) assert.doesNotMatch(await readFile(join(outputDir, path), 'utf8'), /SECRET|private|\.local/);
  });
}

test('a successful CLI with missing reports is rejected with durable failure evidence', async t => {
  const { outputDir } = await fixture(t);
  assert.equal(await runCiEvidence({ profile: 'coverage', outputDir, source,
    run: async () => ({ code: 0, signal: null, durationMs: 1, output: '' }) }), 1);
  const receipt = JSON.parse(await readFile(join(outputDir, 'execution.json'), 'utf8'));
  assert.equal(receipt.commands[0].cliExitCode, 0); assert.equal(receipt.commands[0].evidenceValid, false);
});

test('valid test evidence survives missing coverage output without masking a CLI failure', async t => {
  const { outputDir } = await fixture(t);
  const exit = await runCiEvidence({ profile: 'coverage', outputDir, source, run: async command => {
    const report = command.find(value => value.startsWith('--outputFile=')).slice('--outputFile='.length);
    await writeFile(report, JSON.stringify(tests)); return { code: 7, durationMs: 1, output: '' };
  } });
  assert.equal(exit, 7);
  assert.deepEqual((await readdir(outputDir)).sort(), ['execution.json', 'test-summary.json']);
  const receipt = JSON.parse(await readFile(join(outputDir, 'execution.json'), 'utf8'));
  assert.equal(receipt.tests.reportedSuccess, true); assert.equal(receipt.commands[0].cliExitCode, 7);
});

test('a success flag and zero CLI exit cannot bypass the existing coverage ratchet', async t => {
  const { outputDir } = await fixture(t);
  assert.equal(await runCiEvidence({ profile: 'coverage', outputDir, source, run: async command => {
    await coverageFiles(command);
    const reportDirectory = command.find(value => value.startsWith('--coverage.reportsDirectory=')).slice('--coverage.reportsDirectory='.length);
    const below = structuredClone(coverage); below.total.functions.pct = 96.99;
    await writeFile(join(reportDirectory, 'coverage-summary.json'), JSON.stringify(below));
    return { code: 0, durationMs: 1, output: '' };
  } }), 1);
  const receipt = JSON.parse(await readFile(join(outputDir, 'execution.json'), 'utf8'));
  assert.deepEqual(receipt.coverageRatchet, { statements: 93, branches: 87, functions: 97 });
  assert.equal(receipt.commands[0].cliExitCode, 0); assert.equal(receipt.commands[0].coverageMeetsRatchet, false);
  assert.equal(receipt.tests.reportedSuccess, true); assert.equal(receipt.coverage.functions.pct, 96.99);
});

test('preview still runs both actual environment CLIs after test failure without masking the failure', async t => {
  const { outputDir } = await fixture(t), calls = [];
  const exit = await runCiEvidence({ profile: 'preview', outputDir, source, run: async command => {
    calls.push(command);
    if (command[2] === 'test:preview') return { code: 2, signal: null, durationMs: 1, output: packagingOutput };
    await packageFiles(command); return { code: 0, signal: null, durationMs: 1, output: 'SECRET-NOT-RETAINED' };
  } });
  assert.equal(exit, 2); assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(command => command.slice(0, 5)), [
    ['npm', 'run', 'test:preview'], ['npm', 'run', 'preview:build', '--', 'staging'],
    ['npm', 'run', 'preview:build', '--', 'production'],
  ]);
  const receiptText = await readFile(join(outputDir, 'execution.json'), 'utf8');
  const receipt = JSON.parse(receiptText);
  assert.equal(receipt.commands[0].cliExitCode, 2);
  for (const command of receipt.commands.slice(1)) { assert.equal(command.evidenceValid, true); assert.equal(command.artifact.fileCount, 1); }
  assert.doesNotMatch(receiptText, /SECRET|Raw arbitrary|\.local/);
  assert.deepEqual((await readdir(outputDir)).sort(), ['execution.json', 'test-summary.json']);
});

test('source mutation fails a nominally successful test execution', async t => {
  const { outputDir } = await fixture(t); let count = 0;
  const exit = await runCiEvidence({ profile: 'coverage', outputDir,
    source: async () => ({ ...await source(), trackedInputInventorySha256: String(count++).repeat(64) }),
    run: async command => { await coverageFiles(command); return { code: 0, durationMs: 1, output: '' }; } });
  assert.equal(exit, 1);
  assert.equal(JSON.parse(await readFile(join(outputDir, 'execution.json'), 'utf8')).sourceChangedDuringExecution, true);
});

test('existing evidence is not overwritten and invalid profiles are rejected before execution', async t => {
  const { outputDir } = await fixture(t);
  await mkdir(outputDir); await writeFile(join(outputDir, 'keep.txt'), 'Owned evidence.');
  await assert.rejects(runCiEvidence({ profile: 'coverage', outputDir, source }), /must be empty/);
  assert.equal(await readFile(join(outputDir, 'keep.txt'), 'utf8'), 'Owned evidence.');
  await assert.rejects(runCiEvidence({ profile: 'unknown', outputDir, source }), /Choose coverage or preview/);
});

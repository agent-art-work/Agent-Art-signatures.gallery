import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const credentialKeys = ['XAI_API_KEY', 'OPEN_MINT_X_BEARER_TOKEN', 'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CF_API_TOKEN'];
const ratchet = { statements: 93, branches: 87, functions: 97 };

export function coverageRatchetFromConfig(config) {
  const block = /thresholds:\s*\{([^}]+)\}/.exec(config)?.[1];
  assert.ok(block, 'Missing global coverage ratchet.');
  const actual = Object.fromEntries([...block.matchAll(/(statements|branches|functions|lines):\s*([\d.]+)/g)]
    .map(([, metric, value]) => [metric, Number(value)]));
  assert.deepEqual(actual, ratchet, 'Global coverage ratchet differs from the approved 93/87/97 profile.');
  return actual;
}

// The child cannot inherit GitHub tokens or unrelated provider/runtime settings.
// Core's HTTP/PG opt-ins are retained; preview overrides them to disabled.
export function childEnvironment(environment, profile) {
  const keys = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'PATHEXT',
    'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'CI', 'GITHUB_ACTIONS', 'NODE_ENV',
    'OPEN_MINT_TEST_HTTP', 'OPEN_MINT_TEST_POSTGRES', 'OPEN_MINT_TEST_POSTGRES_BIN'];
  const result = Object.fromEntries(keys.filter(key => environment[key] !== undefined)
    .map(key => [key, environment[key]]));
  for (const key of credentialKeys) result[key] = '';
  Object.assign(result, { NO_COLOR: '1', FORCE_COLOR: '0', WRANGLER_SEND_METRICS: 'false' });
  if (profile === 'preview') Object.assign(result, { OPEN_MINT_TEST_HTTP: '', OPEN_MINT_TEST_POSTGRES: '' });
  return result;
}

export function summarizeVitest(report) {
  assert.ok(report && typeof report === 'object', 'Missing Vitest execution report.');
  const counters = ['numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites',
    'numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests'];
  const result = {};
  for (const key of counters) {
    assert.ok(Number.isSafeInteger(report[key]) && report[key] >= 0, `Invalid Vitest ${key}.`);
    result[key] = report[key];
  }
  assert.ok(result.numTotalTests > 0, 'No tests executed.');
  assert.equal(typeof report.success, 'boolean', 'Missing Vitest success flag.');
  // This flag is descriptive, never a replacement for the real CLI exit.
  result.reportedSuccess = report.success;
  return result;
}

export function summarizeCoverage(report) {
  assert.ok(report?.total, 'Missing coverage total.');
  const total = {};
  for (const metric of ['lines', 'statements', 'functions', 'branches']) {
    const value = report.total[metric];
    assert.ok(value && ['total', 'covered', 'skipped'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0),
      `Invalid ${metric} coverage counts.`);
    assert.ok(typeof value.pct === 'number' && Number.isFinite(value.pct) && value.pct >= 0 && value.pct <= 100,
      `Invalid ${metric} coverage percent.`);
    total[metric] = Object.fromEntries(['total', 'covered', 'skipped', 'pct'].map(key => [key, value[key]]));
  }
  return { total };
}

export function summarizePreviewTests(output) {
  const result = {};
  for (const field of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const match = new RegExp(`^# ${field} (\\d+)$`, 'm').exec(output);
    assert.ok(match, `Missing Node test ${field} count.`);
    result[field] = Number(match[1]);
  }
  assert.ok(result.tests > 0 && result.pass > 0, 'No packaging tests executed.');
  const required = ['staging', 'production'].flatMap(environment => [
    `${environment} manifest exactly inventories a deterministic public preview package`,
    `${environment} contains no backend, native renderer, secret or network-capable browser module`,
    `${environment} packaged Worker and assets execute inside real Cloudflare workerd`,
  ]);
  result.requiredCases = required.map(name => ({ name,
    passed: output.split('\n').some(line => /^ok \d+ - /.test(line) && line.slice(line.indexOf(' - ') + 3) === name) }));
  assert.ok(result.requiredCases.every(test => test.passed), 'Required preview packaging/workerd cases did not pass.');
  const vitest = /^\s*Tests\s+([^\n]+)$/m.exec(output);
  assert.ok(vitest, 'Missing preview Vitest summary.');
  result.unit = {};
  for (const [, count, status] of vitest[1].matchAll(/(\d+) (passed|failed|skipped|todo)/g)) result.unit[status] = Number(count);
  assert.ok(result.unit.passed > 0, 'No preview unit tests executed.');
  return result;
}

export async function captureSource(repository) {
  const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: repository, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const inventory = [];
  for (const path of paths) inventory.push({ path, sha256: sha256(await readFile(join(repository, path))) });
  return { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
    worktreeClean: git('status', '--porcelain', '--untracked-files=normal') === '',
    trackedInputInventorySha256: sha256(JSON.stringify(inventory)), trackedInputFiles: inventory.length,
    trackedDiffSha256: sha256(execFileSync('git', ['diff', 'HEAD', '--binary'], { cwd: repository })) };
}

export function execute(command, { repository, environment }) {
  return new Promise(resolveResult => {
    const started = performance.now();
    const child = spawn(command[0], command.slice(1), { cwd: repository, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', spawnError = false;
    const capture = (stream, bytes) => {
      stream.write(bytes);
      // Used solely for synthetic TAP/CLI summaries; raw output is never saved
      // or uploaded. A bounded tail suffices for TAP totals and package output.
      output = (output + bytes.toString()).slice(-4 * 1024 * 1024);
    };
    child.stdout.on('data', bytes => capture(process.stdout, bytes));
    child.stderr.on('data', bytes => capture(process.stderr, bytes));
    child.on('error', () => { spawnError = true; });
    child.on('close', (code, signal) => resolveResult({ code, signal, spawnError,
      durationMs: Math.round(performance.now() - started), output }));
  });
}

// Reports contain only exact-source identity, fixed command/profile metadata,
// numeric summaries and generated artifact digests. Never raw logs/test payloads.
export async function runCiEvidence({ profile, outputDir, repository = root, environment = process.env,
  run = execute, source = captureSource } = {}) {
  assert.ok(['coverage', 'preview'].includes(profile), 'Choose coverage or preview.');
  assert.ok(outputDir, 'An evidence output directory is required.');
  outputDir = resolve(outputDir);
  assert.notEqual(outputDir, resolve(repository), 'Evidence must not be the source directory.');
  await mkdir(outputDir, { recursive: true });
  assert.equal((await readdir(outputDir)).length, 0, 'Evidence output must be empty.');
  const env = childEnvironment(environment, profile);
  const receipt = { schema: 'signatures-gallery.ci-execution.v1', profile, source: await source(repository),
    node: process.version, optIns: { http: env.OPEN_MINT_TEST_HTTP === '1', postgres: env.OPEN_MINT_TEST_POSTGRES === '1' },
    credentials: 'empty-allowlisted-child-environment', commands: [], exitCode: 0 };
  if (profile === 'coverage') receipt.coverageRatchet = coverageRatchetFromConfig(await readFile(join(repository, 'vitest.config.ts'), 'utf8'));
  const scratch = await mkdtemp(join(tmpdir(), 'sg-ci-evidence-'));
  const writeReport = (name, report) => writeFile(join(outputDir, name), JSON.stringify(report, null, 2) + '\n');
  const commands = profile === 'coverage' ? [{ label: 'global-vitest-coverage', command: ['npm', 'run', 'test:coverage', '--',
    '--reporter=default', '--reporter=json', `--outputFile=${join(scratch, 'vitest.json')}`,
    `--coverage.reportsDirectory=${join(scratch, 'coverage')}`] }] : [
    { label: 'preview-unit-and-node-packaging-workerd', command: ['npm', 'run', 'test:preview'] },
    ...['staging', 'production'].map(target => ({ label: `preview-build-${target}`, target,
      command: ['npm', 'run', 'preview:build', '--', target, '--output-dir', join(scratch, target)] })),
  ];
  try {
    for (const spec of commands) {
      const result = await run(spec.command, { repository, environment: env });
      const command = { label: spec.label, argv: spec.command.map(value => value.replaceAll(scratch, '<disposable-output>')),
        cliExitCode: result.code, signal: result.signal ?? null, spawnError: result.spawnError === true,
        durationMs: result.durationMs, evidenceValid: false };
      receipt.commands.push(command);
      try {
        if (profile === 'coverage') {
          const tests = summarizeVitest(JSON.parse(await readFile(join(scratch, 'vitest.json'), 'utf8')));
          await writeReport('test-summary.json', tests);
          receipt.tests = tests;
          const coverage = summarizeCoverage(JSON.parse(await readFile(join(scratch, 'coverage/coverage-summary.json'), 'utf8')));
          await writeReport('coverage-summary.json', coverage);
          receipt.coverage = coverage.total;
          command.coverageMeetsRatchet = Object.entries(receipt.coverageRatchet)
            .every(([metric, minimum]) => coverage.total[metric].pct >= minimum);
          assert.ok(command.coverageMeetsRatchet, 'Coverage is below the unchanged ratchet.');
        } else if (!spec.target) {
          receipt.tests = summarizePreviewTests(result.output);
          await writeReport('test-summary.json', receipt.tests);
        } else {
          const manifestBytes = await readFile(join(scratch, spec.target, 'manifest.json'));
          const manifest = JSON.parse(manifestBytes);
          assert.equal(manifest.environment, spec.target);
          assert.equal(manifest.schema, 'signatures-gallery.preview-cloudflare.v1');
          assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
          for (const file of manifest.files) {
            assert.ok(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.startsWith('/') && !file.path.includes('..'));
            const bytes = await readFile(join(scratch, spec.target, file.path));
            assert.equal(bytes.length, file.bytes); assert.equal(sha256(bytes), file.sha256);
          }
          assert.equal(sha256(await readFile(join(scratch, spec.target, 'worker.mjs'))), manifest.artifactSha256);
          command.artifact = { environment: spec.target, manifestSha256: sha256(manifestBytes),
            workerSha256: manifest.artifactSha256, fileCount: manifest.files.length };
        }
        command.evidenceValid = true;
      } catch {
        // A missing/invalid report never converts a CLI failure to success.
        // Do not retain parse errors, arbitrary file content or raw logs.
        command.evidenceError = 'Expected synthetic summary or artifact was missing or invalid.';
      }
      const exit = result.code === 0 && !result.spawnError && !result.signal ? (command.evidenceValid ? 0 : 1) :
        (Number.isInteger(result.code) && result.code > 0 && result.code <= 255 ? result.code : 1);
      if (receipt.exitCode === 0 && exit !== 0) receipt.exitCode = exit;
      await writeReport('execution.json', receipt);
      // Preview packaging CLIs still run after a test failure, preserving each
      // independent CLI's evidence while the overall job stays failed.
    }
    receipt.sourceAfter = await source(repository);
    if (receipt.source.trackedInputInventorySha256 !== receipt.sourceAfter.trackedInputInventorySha256) {
      receipt.sourceChangedDuringExecution = true;
      if (receipt.exitCode === 0) receipt.exitCode = 1;
    }
    await writeReport('execution.json', receipt);
    return receipt.exitCode;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [profile, flag, outputDir, ...extra] = process.argv.slice(2);
  assert.ok(flag === '--output-dir' && outputDir && extra.length === 0,
    'Usage: ci-test-evidence.mjs coverage|preview --output-dir <empty-directory>');
  process.exitCode = await runCiEvidence({ profile, outputDir });
}

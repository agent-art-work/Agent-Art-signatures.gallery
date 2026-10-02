import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { discoverPulseMockSuites, LOCAL_EVM_SUITES, pulseCiArguments } from '../../scripts/test-pulse-ci.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the CI selector includes every Pulse mock suite, including future files, with one explicit local-EVM exclusion', () => {
  const names = readdirSync(new URL('./', import.meta.url));
  const all = names.filter(name => /^pulse-.*\.node-test\.mjs$/.test(name)).sort();
  const selected = discoverPulseMockSuites(names);
  assert.deepEqual([...selected, ...LOCAL_EVM_SUITES].sort(), all);
  for (const name of ['pulse-ci.node-test.mjs', 'pulse-c7-browser.node-test.mjs',
    'pulse-ui-accessibility.node-test.mjs',
    'pulse-sepolia-admin-verify.node-test.mjs',
    'pulse-sepolia-admin-client.node-test.mjs', 'pulse-sepolia-admin-page.node-test.mjs',
    'pulse-sepolia-admin-web-http.node-test.mjs', 'pulse-sepolia-admin-web-service.node-test.mjs',
    'pulse-sepolia-rpc-errors.node-test.mjs', 'pulse-sepolia-relay-store.node-test.mjs']) {
    assert.ok(selected.includes(name), `CI omitted ${name}`);
  }
  assert.deepEqual(discoverPulseMockSuites(['other.node-test.mjs', 'pulse-future-regression.node-test.mjs',
    ...LOCAL_EVM_SUITES]), ['pulse-future-regression.node-test.mjs']);
  assert.deepEqual(pulseCiArguments(names), ['--import', 'tsx', '--test', '--test-concurrency=4',
    ...selected.map(name => `contracts/tools/${name}`)]);
  assert.throws(() => pulseCiArguments([]), /No mocked Pulse/);
});

test('the workflow actually runs the mock selector, enables disposable PostgreSQL 16 and verifies all Pulse locks', () => {
  const pkg = JSON.parse(read('../../package.json'));
  assert.equal(pkg.scripts['test:pulse:ci'], 'node scripts/test-pulse-ci.mjs');
  const workflow = read('../../.github/workflows/verify.yml');
  const job = workflow.split('\n  pulse:\n')[1];
  assert.ok(job, 'Pulse CI must remain a distinct bounded job');
  assert.match(job, /timeout-minutes: 10/);
  assert.match(job, /OPEN_MINT_TEST_POSTGRES: '1'/);
  assert.match(job, /OPEN_MINT_TEST_POSTGRES_BIN: \/usr\/lib\/postgresql\/16\/bin/);
  assert.match(job, /sudo apt-get install -y postgresql-16/);
  assert.match(job, /forge build --offline/);
  for (const command of ['pulse:verify', 'pulse:candidate:verify', 'pulse:admin:candidate:verify', 'test:pulse:ci']) {
    assert.match(job, new RegExp(`npm run ${command}(?:\\s|$)`), `Workflow omitted ${command}`);
  }
  assert.match(job, /node --test contracts\/tools\/preformal-backup\.node-test\.mjs/);
  assert.match(job, /node --import tsx scripts\/pulse-ui-accessibility\.mjs --output-dir "\$RUNNER_TEMP\/pulse-ui-accessibility"/);
  const evidence = job.split('      - name: Retain only synthetic accessibility screenshots and measurements\n')[1];
  assert.ok(evidence, 'CI must retain synthetic browser evidence, including partial screenshots on audit failure');
  assert.match(evidence, /if: \$\{\{ always\(\) \}\}/);
  assert.match(evidence, /uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/);
  assert.match(evidence, /timeout-minutes: 2/);
  const paths = evidence.match(/\n\s+path: \|\n((?: {12}[^\n]+\n)+)/)?.[1].trim().split('\n').map(path => path.trim());
  assert.deepEqual(paths, ['${{ runner.temp }}/pulse-ui-accessibility/*.png',
    '${{ runner.temp }}/pulse-ui-accessibility/results.json']);
  assert.match(evidence, /if-no-files-found: ignore/);
  assert.match(evidence, /retention-days: 7/);
  assert.match(evidence, /include-hidden-files: false/);
  assert.doesNotMatch(evidence, /github\.workspace|path:\s*\.local|pulse-ui-accessibility\/\*\*/,
    'Evidence must not collect real-site screenshots, secrets, logs or browser profiles');
  assert.match(job, /XAI_API_KEY: ''/);
  assert.match(job, /OPEN_MINT_X_BEARER_TOKEN: ''/);
  assert.doesNotMatch(job, /secrets\.|--env-file|--execute-approved|--broadcast|SEPOLIA_(?:ADMIN_)?PRIVATE_KEY/);
  assert.doesNotMatch(job, /npm run test:pulse:c[23456](?:\s|$)/,
    'Do not nest earlier phase campaigns or repeat the full Foundry test campaign here');
});

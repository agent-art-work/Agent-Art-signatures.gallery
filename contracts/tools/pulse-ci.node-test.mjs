import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { discoverPulseMockSuites, LOCAL_EVM_SUITES, pulseCiArguments } from '../../scripts/test-pulse-ci.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

// This is the complete pre-partition campaign, not a new reduced smoke suite.
// Keep original arguments and order inside each independent lane. Bootstrap
// builds below are prerequisites, not repeated test/rehearsal campaigns.
const INHERITED_CAMPAIGNS = {
  verify: [
    'renderer:verify', 'typecheck', 'test:coverage', 'build', 'test:contract',
    'generative:release:check', 'test:generative:release', 'test:generative:deployment:coverage',
    'generative:numerical-review', 'test:generative:numerics', 'test:generative:operating-plan',
    'generative:deployment:rehearsal -- --execute-local-test-transactions',
    'generative:active-state:rehearsal -- --execute-local-test-transactions',
    'generative:read-limits -- --execute-local-test-transactions',
    'generative:rehearsal -- --execute-local-test-transactions --release-candidate --quick --mint --backend',
    'generative:rehearsal -- --execute-local-test-transactions --release-candidate --quick --mint --backend --review-files',
    'generative:rehearsal -- --execute-local-test-transactions --quick --mint --backend',
    'test:manifest', 'test:manifest:roles', 'test:open:manifest', 'test:onchain:manifest',
    'open:rehearsal -- --execute-local-test-transactions',
  ],
  admission: [
    'test:generative:active-state:coverage', 'test:generative:admission:coverage',
    'test:generative:assessment-admission', 'test:generative:mint-admission', 'test:generative:reuse-admission',
    'test:generative:local-review', 'test:generative:local-runtime',
    'test:generative:review-files', 'test:generative:review-startup', 'test:generative:database-certification',
  ],
  staging: [
    'test:generative:readiness-http', 'test:generative:staging-readiness',
    'test:generative:staging-review', 'test:generative:staging-assessment',
    'test:generative:staging-transport', 'test:generative:staging-sharing',
  ],
  mint: ['test:generative:staging-mint'],
  runtime: ['test:generative:staging-runtime'],
  recovery: [
    'test:generative:staging-restore', 'test:generative:staging-recovery-unit',
    'test:generative:staging-recovery-pg', 'test:generative:staging-recovery-flow',
  ],
};
const jobBlocks = workflow => {
  const boundary = workflow.indexOf('\njobs:\n');
  assert.ok(boundary >= 0, 'Workflow must declare jobs');
  workflow = workflow.slice(boundary + '\njobs:\n'.length);
  const starts = [...workflow.matchAll(/^  ([a-z][a-z0-9_-]*):\n/gm)];
  assert.equal(new Set(starts.map(match => match[1])).size, starts.length, 'Duplicate CI lane');
  return Object.fromEntries(starts.map((match, i) =>
    [match[1], workflow.slice(match.index, starts[i + 1]?.index ?? workflow.length)]));
};
const npmCampaign = job => {
  const commands = [];
  let shellBlock = false;
  const executable = /^(?:OPEN_MINT_TEST_ORIGIN="\$OPEN_MINT_ORIGIN" )?npm run (.+)$/;
  for (const line of job.split('\n')) {
    const run = line.match(/^ {8}run: (.+)$/);
    if (run) {
      shellBlock = run[1] === '|';
      const command = run[1].match(executable);
      if (command) commands.push(command[1].trim());
    } else if (shellBlock) {
      // Only executable lines in this run block count. Comments, echo text
      // and other YAML fields cannot stand in for a selected campaign.
      if (line !== '' && !line.startsWith('          ')) shellBlock = false;
      else {
        const command = line.slice(10).match(executable);
        if (command) commands.push(command[1].trim());
      }
    }
  }
  return commands;
};
function verifyInheritedLanes(workflow) {
  const jobs = jobBlocks(workflow);
  assert.deepEqual(Object.keys(jobs), ['verify', 'admission', 'staging', 'mint', 'runtime', 'recovery', 'pulse']);
  const budgets = { verify: 35, admission: 20, staging: 25, mint: 20, runtime: 20, recovery: 20, pulse: 10 };
  for (const [name, commands] of Object.entries(INHERITED_CAMPAIGNS)) {
    assert.deepEqual(npmCampaign(jobs[name]), commands, `Lost, duplicated, reordered or changed command in ${name}`);
  }
  assert.equal(Object.values(INHERITED_CAMPAIGNS).flat().length, 44);
  assert.deepEqual(Object.entries(jobs).filter(([name]) => name !== 'pulse').flatMap(([, job]) => npmCampaign(job)).sort(),
    Object.values(INHERITED_CAMPAIGNS).flat().sort(), 'Every inherited campaign command must run exactly once');
  for (const [name, job] of Object.entries(jobs)) {
    assert.match(job, /runs-on: ubuntu-24\.04/);
    assert.match(job, new RegExp(`\n    timeout-minutes: ${budgets[name]}\n`));
    const actions = [...job.matchAll(/uses: ([^\n]+)/g)].map(match => match[1]);
    assert.deepEqual(actions.slice(0, 3), [
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7',
      'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6',
      'foundry-rs/foundry-toolchain@908c540300062bd5a7e473851cdb4282204cee09 # v1',
    ]);
    assert.equal(actions.length, name === 'pulse' ? 4 : 3, 'Only Pulse may upload its bounded synthetic browser evidence');
    assert.match(job, /persist-credentials: false/);
    assert.match(job, /node-version: '22'/);
    assert.match(job, /version: v1\.5\.1/);
    assert.equal([...job.matchAll(/\bnpm ci\b/g)].length, 1, `Fresh locked dependencies missing in ${name}`);
    assert.match(job, /sudo apt-get install -y postgresql-16/);
    assert.match(job, /OPEN_MINT_TEST_POSTGRES: '1'/);
    assert.match(job, /OPEN_MINT_TEST_POSTGRES_BIN: \/usr\/lib\/postgresql\/16\/bin/);
    assert.match(job, /XAI_API_KEY: ''/);
    assert.match(job, /OPEN_MINT_X_BEARER_TOKEN: ''/);
    assert.doesNotMatch(job, /secrets\.|--env-file|--execute-approved|--broadcast|SEPOLIA_(?:ADMIN_)?PRIVATE_KEY|\.local\/rehearsal/);
    assert.doesNotMatch(job, /\n\s+needs:|continue-on-error:|actions\/download-artifact/,
      'Lanes must be independently bootstrapped and must not hide test failures');
    if (name !== 'pulse') assert.doesNotMatch(job, /\n\s+if:|actions\/upload-artifact|include-hidden-files:/,
      'Do not skip inherited checks or upload private SQL, packages, logs or runtime state');
    if (['admission', 'staging', 'mint', 'runtime', 'recovery'].includes(name)) {
      assert.match(job, /working-directory: contracts\n        run: forge build --offline\n/);
      const install = job.indexOf('npm ci'), compile = job.indexOf('forge build --offline');
      const lock = job.indexOf('node scripts/verify-generative-release.mjs');
      assert.ok(install < compile && compile < lock && lock < job.indexOf(`npm run ${INHERITED_CAMPAIGNS[name][0]}`),
        `${name} must compile and verify its own release prerequisites before tests`);
      assert.match(job, /OPEN_MINT_TEST_HTTP: '1'/);
    }
  }
}

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

test('independent lanes preserve all 44 inherited campaign commands exactly once with fresh offline prerequisites', () => {
  verifyInheritedLanes(read('../../.github/workflows/verify.yml'));
  const pkg = JSON.parse(read('../../package.json'));
  assert.equal(pkg.scripts['test:contract'], 'cd contracts && forge test --offline');
});

test('lane guards reject omitted commands, duplicate campaigns, lost local-effect fences and unsafe coupling', () => {
  const workflow = read('../../.github/workflows/verify.yml');
  for (const changed of [
    workflow.replace('          npm run test:generative:staging-assessment\n', ''),
    workflow.replace('          npm run test:generative:staging-assessment\n',
      '          # npm run test:generative:staging-assessment\n'),
    workflow.replace('        run: npm run test:generative:staging-mint',
      '        run: echo npm run test:generative:staging-mint'),
    workflow.replace('        run: npm run test:generative:local-review',
      '        run: |\n          npm run test:generative:local-review\n          npm run test:generative:local-review'),
    workflow.replace('generative:deployment:rehearsal -- --execute-local-test-transactions', 'generative:deployment:rehearsal'),
    workflow.replace("      XAI_API_KEY: ''", '      XAI_API_KEY: ${{ secrets.XAI_API_KEY }}'),
    workflow.replace('  admission:\n', '  admission:\n    needs: verify\n'),
    workflow.replace('  recovery:\n', '  recovery:\n    continue-on-error: true\n'),
    workflow.replace('  staging:\n', '  staging:\n    if: ${{ false }}\n'),
    workflow.replace('  recovery:\n', '  recovery:\n    # forbidden --env-file=.env.local\n'),
    workflow.replace('  admission:\n', '  admission:\n    # forbidden actions/upload-artifact path: .local/rehearsal\n'),
    workflow.replace('        run: forge build --offline', '        run: forge build'),
  ]) assert.throws(() => verifyInheritedLanes(changed), assert.AssertionError);
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

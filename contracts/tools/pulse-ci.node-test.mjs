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
const COVERAGE_RUNNER = 'node scripts/ci-test-evidence.mjs coverage --output-dir "$RUNNER_TEMP/verify-test-evidence"';
const executableLines = job => {
  const commands = [];
  let shellBlock = false;
  for (const line of job.split('\n')) {
    const run = line.match(/^ {8}run: (.+)$/);
    if (run) {
      shellBlock = run[1] === '|';
      if (!shellBlock) commands.push(run[1]);
    } else if (shellBlock) {
      // Only executable lines in this run block count. Comments, echo text
      // and other YAML fields cannot stand in for a selected campaign.
      if (line !== '' && !line.startsWith('          ')) shellBlock = false;
      else if (line.slice(10).trim() && !line.slice(10).startsWith('#')) commands.push(line.slice(10));
    }
  }
  return commands;
};
const npmCampaign = job => executableLines(job).flatMap(line => {
  const npm = line.match(/^(?:OPEN_MINT_TEST_ORIGIN="\$OPEN_MINT_ORIGIN" )?npm run (.+)$/);
  if (npm) return [npm[1].trim()];
  // Count only this exact executable evidence runner as the inherited coverage
  // campaign. Its presence is independently required below, so bare npm
  // coverage cannot replace it while bypassing durable failure evidence.
  return line === COVERAGE_RUNNER ? ['test:coverage'] : [];
});
function verifyEvidenceUpload(job, directory, files) {
  assert.equal([...job.matchAll(/uses: actions\/upload-artifact@/g)].length, 1);
  const starts = [...job.matchAll(/^ {6}- (?:name:|uses:)/gm)];
  const steps = starts.map((match, index) => job.slice(match.index, starts[index + 1]?.index ?? job.length));
  const uploads = steps.filter(step => /^(?: {6}- | {8})uses: actions\/upload-artifact@/m.test(step));
  assert.equal(uploads.length, 1, 'Evidence configuration must belong to an actual upload step');
  const upload = uploads[0];
  assert.match(upload, /uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/);
  assert.deepEqual([...job.matchAll(/\n\s+if: ([^\n]+)/g)].map(match => match[1]), ['${{ always() }}'],
    'Only failure-safe upload may be conditional; never skip campaign execution');
  assert.deepEqual([...upload.matchAll(/\n {8}if: ([^\n]+)/g)].map(match => match[1]), ['${{ always() }}'],
    'The upload step itself must retain evidence after execution fails');
  const paths = upload.match(/\n\s+path: \|\n((?: {12}[^\n]+\n)+)/)?.[1].trim().split('\n').map(path => path.trim());
  assert.deepEqual(paths, files.map(file => '${{ runner.temp }}/' + directory + '/' + file),
    'Upload only the intentional sanitized evidence files');
  assert.match(upload, /if-no-files-found: ignore/);
  assert.match(upload, /retention-days: 14/);
  assert.match(upload, /include-hidden-files: false/);
}
function verifyInheritedLanes(workflow) {
  const jobs = jobBlocks(workflow);
  assert.deepEqual(Object.keys(jobs), ['verify', 'preview', 'admission', 'staging', 'mint', 'runtime', 'recovery', 'pulse']);
  const budgets = { verify: 35, preview: 10, admission: 20, staging: 25, mint: 20, runtime: 30, recovery: 20, pulse: 10 };
  for (const [name, commands] of Object.entries(INHERITED_CAMPAIGNS)) {
    assert.deepEqual(npmCampaign(jobs[name]), commands, `Lost, duplicated, reordered or changed command in ${name}`);
  }
  assert.equal(Object.values(INHERITED_CAMPAIGNS).flat().length, 44);
  assert.equal(executableLines(jobs.verify).filter(line => line === COVERAGE_RUNNER).length, 1,
    'Verify must execute exactly one unchanged coverage evidence runner');
  assert.deepEqual(Object.keys(INHERITED_CAMPAIGNS).flatMap(name => npmCampaign(jobs[name])).sort(),
    Object.values(INHERITED_CAMPAIGNS).flat().sort(), 'Every inherited campaign command must run exactly once');
  for (const [name, job] of Object.entries(jobs)) {
    assert.match(job, /runs-on: ubuntu-24\.04/);
    assert.match(job, new RegExp(`\n    timeout-minutes: ${budgets[name]}\n`));
    const actions = [...job.matchAll(/uses: ([^\n]+)/g)].map(match => match[1]);
    assert.deepEqual(actions.slice(0, 2), [
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7',
      'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6',
    ]);
    assert.equal(actions.length, ['verify', 'pulse'].includes(name) ? 4 : 3,
      'Only Verify/preview/Pulse may upload their bounded synthetic evidence');
    assert.match(job, /persist-credentials: false/);
    assert.match(job, /node-version: '22'/);
    assert.equal([...job.matchAll(/\bnpm ci\b/g)].length, 1, `Fresh locked dependencies missing in ${name}`);
    assert.match(job, /XAI_API_KEY: ''/);
    assert.match(job, /OPEN_MINT_X_BEARER_TOKEN: ''/);
    assert.doesNotMatch(job, /secrets\.|--env-file|--execute-approved|--broadcast|SEPOLIA_(?:ADMIN_)?PRIVATE_KEY|\.local\/rehearsal/);
    assert.doesNotMatch(job, /\n\s+needs:|continue-on-error:|actions\/download-artifact/,
      'Lanes must be independently bootstrapped and must not hide test failures');
    if (!['verify', 'preview', 'pulse'].includes(name)) assert.doesNotMatch(job, /\n\s+if:|actions\/upload-artifact|include-hidden-files:/,
      'Do not skip inherited checks or upload private SQL, packages, logs or runtime state');
    if (name === 'preview') {
      assert.deepEqual(npmCampaign(job), [], 'Preview must not repeat inherited npm campaigns');
      assert.equal(actions[2], 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1');
      const commands = executableLines(job);
      for (const required of ['node scripts/ci-test-evidence.mjs preview --output-dir "$RUNNER_TEMP/preview-test-evidence"',
        'node --test contracts/tools/ci-test-evidence.node-test.mjs']) {
        assert.equal(commands.filter(line => line === required).length, 1,
          'Preview must execute each acceptance/evidence command exactly once; comments cannot substitute');
      }
      for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CF_API_TOKEN',
        'OPEN_MINT_TEST_HTTP', 'OPEN_MINT_TEST_POSTGRES']) assert.match(job, new RegExp(`\\n      ${key}: ''\\n`));
      assert.match(job, /WRANGLER_SEND_METRICS: 'false'/);
      assert.doesNotMatch(job, /foundry|forge |postgresql-16|OPEN_MINT_TEST_POSTGRES_BIN|\.local\/|wrangler (?:deploy|login)/,
        'Preview has no contract/database/runtime/deployment prerequisites');
      verifyEvidenceUpload(job, 'preview-test-evidence', ['execution.json', 'test-summary.json']);
      continue;
    }
    assert.equal(actions[2], 'foundry-rs/foundry-toolchain@908c540300062bd5a7e473851cdb4282204cee09 # v1');
    assert.match(job, /version: v1\.5\.1/);
    assert.match(job, /sudo apt-get install -y postgresql-16/);
    assert.match(job, /OPEN_MINT_TEST_POSTGRES: '1'/);
    assert.match(job, /OPEN_MINT_TEST_POSTGRES_BIN: \/usr\/lib\/postgresql\/16\/bin/);
    if (name === 'verify') verifyEvidenceUpload(job, 'verify-test-evidence',
      ['execution.json', 'test-summary.json', 'coverage-summary.json']);
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

test('preview and coverage evidence guards reject coupling, credentials, repeated inherited campaigns and broad uploads', () => {
  const workflow = read('../../.github/workflows/verify.yml');
  const jobs = jobBlocks(workflow);
  const change = (name, from, to) => {
    assert.ok(jobs[name].includes(from), 'Mutation must exercise an actual executable/configuration field');
    return workflow.replace(jobs[name], jobs[name].replace(from, to));
  };
  for (const changed of [
    change('preview', '  preview:\n', '  preview:\n    needs: verify\n'),
    change('preview', '  preview:\n', '  preview:\n    continue-on-error: true\n'),
    change('preview', '    timeout-minutes: 10\n', '    timeout-minutes: 20\n'),
    change('preview', "      CLOUDFLARE_API_TOKEN: ''\n", '      CLOUDFLARE_API_TOKEN: nonempty\n'),
    change('preview', "      OPEN_MINT_TEST_POSTGRES: ''\n", "      OPEN_MINT_TEST_POSTGRES: '1'\n"),
    change('preview', "      WRANGLER_SEND_METRICS: 'false'\n", "      WRANGLER_SEND_METRICS: 'true'\n"),
    change('preview', 'run: node scripts/ci-test-evidence.mjs preview ', 'run: node scripts/ci-test-evidence.mjs coverage '),
    ...['node scripts/ci-test-evidence.mjs preview --output-dir "$RUNNER_TEMP/preview-test-evidence"',
      'node --test contracts/tools/ci-test-evidence.node-test.mjs'].map(command =>
      change('preview', `        run: ${command}\n`, `        # run: ${command}\n        run: echo skipped-preview\n`)),
    change('preview', '        run: npm ci\n', '        run: |\n          npm ci\n          npm run test:coverage\n'),
    change('preview', '        run: npm ci\n', '        run: |\n          npm ci\n          forge build --offline\n'),
    change('preview', '${{ runner.temp }}/preview-test-evidence/execution.json', '${{ runner.temp }}/preview-test-evidence/**'),
    change('preview', 'if: ${{ always() }}', 'if: ${{ success() }}'),
    change('preview', 'include-hidden-files: false', 'include-hidden-files: true'),
    change('verify', 'run: node scripts/ci-test-evidence.mjs coverage ', 'run: echo node scripts/ci-test-evidence.mjs coverage '),
    change('verify', `run: ${COVERAGE_RUNNER}`, 'run: npm run test:coverage'),
    change('verify', '${{ runner.temp }}/verify-test-evidence/coverage-summary.json', '${{ github.workspace }}/.local/**'),
    change('verify', 'if: ${{ always() }}', 'if: ${{ false }}'),
  ]) assert.throws(() => verifyInheritedLanes(changed), assert.AssertionError);
  for (const name of ['verify', 'preview']) {
    const condition = '        if: ${{ always() }}\n';
    const build = name === 'verify' ? '      - name: Build\n' :
      '      - name: Test preview, real workerd and both packaging CLI targets offline\n';
    assert.ok(jobs[name].includes(condition) && jobs[name].includes(build));
    const relocated = jobs[name].replace(condition, '').replace(build, build + condition);
    assert.throws(() => verifyInheritedLanes(workflow.replace(jobs[name], relocated)), assert.AssertionError,
      'An always condition on a build/test step cannot substitute for failure-safe upload');
  }
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

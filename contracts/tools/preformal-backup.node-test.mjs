import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveBackup, archivePaths, BACKUP_NAME, hashFile, snapshotTree } from '../../scripts/archive-preformal-backup.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'preformal-backup-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = archivePaths(root);
  await mkdir(paths.source, { recursive: true, mode: 0o700 });
  await writeFile(join(paths.source, 'README.md'), 'Unique old stopped snapshot', { mode: 0o600 });
  return { root, ...paths };
}
test('targets only the exact historical backup, never active rehearsal', () => {
  const paths = archivePaths('/example/repo');
  assert.equal(paths.source, '/example/repo/.local/backups/' + BACKUP_NAME);
  assert.equal(paths.archive, paths.source + '.tar.zst');
  assert.equal(paths.manifest, paths.source + '.manifest.json');
  assert.ok(!paths.source.startsWith('/example/repo/.local/rehearsal'));
});
test('snapshot hashes every ordinary file and preserves directory/file modes', async t => {
  const f = await fixture(t);
  await mkdir(join(f.source, 'empty'), { mode: 0o700 });
  await writeFile(join(f.source, 'bytes'), Buffer.from([0, 1, 255]), { mode: 0o640 });
  const entries = await snapshotTree(f.source);
  assert.deepEqual(entries.map(e => e.path), ['.', 'README.md', 'bytes', 'empty']);
  assert.equal(entries[2].mode, 0o640);
  assert.equal(entries[2].size, 3);
  assert.equal(entries[2].sha256, await hashFile(join(f.source, 'bytes')));
  const before = entries[2].sha256;
  await writeFile(join(f.source, 'bytes'), Buffer.from([0, 2, 255]));
  assert.notEqual((await snapshotTree(f.source))[2].sha256, before);
});
test('rejects symlinks rather than following targets outside the backup', async t => {
  const f = await fixture(t);
  await symlink(join(f.source, 'README.md'), join(f.source, 'escape'));
  await assert.rejects(snapshotTree(f.source), /symlinks require a separate review/);
});
test('default is read-only dry run and cannot retire the loose copy', async t => {
  const f = await fixture(t), before = await snapshotTree(f.source);
  const result = await archiveBackup(f.root);
  assert.equal(result.execute, false);
  assert.equal(result.entries, 2);
  assert.ok(result.sourceBytes > 0);
  assert.deepEqual(await snapshotTree(f.source), before);
  await assert.rejects(archiveBackup(f.root, { retire: true }), /explicit execution/);
});
test('rejects a redirected historical backup path', async t => {
  const f = await fixture(t), other = join(f.root, 'other');
  await mkdir(other);
  await rm(f.source, { recursive: true });
  await symlink(other, f.source);
  await assert.rejects(archiveBackup(f.root), /must not be a symlink/);
});

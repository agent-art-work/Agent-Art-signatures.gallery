import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BACKUP_NAME = 'pre-formal-v1-20260910';
export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function snapshotTree(root) {
  const entries = [];
  async function visit(path, relative) {
    const before = await lstat(path);
    assert.ok(!before.isSymbolicLink(), 'Backup symlinks require a separate review');
    const base = { path: relative, mode: before.mode & 0o777, type: before.isDirectory() ? 'directory' : 'file' };
    if (before.isDirectory()) {
      entries.push(base);
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), relative === '.' ? name : relative + '/' + name);
    } else {
      assert.ok(before.isFile(), 'Backup must contain only ordinary files and directories');
      const sha256 = await hashFile(path), after = await lstat(path);
      assert.equal(after.size, before.size, 'Backup changed during hashing');
      assert.equal(after.mtimeMs, before.mtimeMs, 'Backup changed during hashing');
      entries.push({ ...base, size: before.size, sha256 });
    }
  }
  await visit(root, '.');
  return entries;
}
function run(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept(stdout) : reject(Object.assign(new Error(command + ' failed: ' + stderr.slice(0, 800)), { exitCode: code })));
  });
}
async function syncPath(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
export function archivePaths(repoRoot) {
  const parent = join(resolve(repoRoot), '.local', 'backups');
  return { parent, source: join(parent, BACKUP_NAME), archive: join(parent, BACKUP_NAME + '.tar.zst'), manifest: join(parent, BACKUP_NAME + '.manifest.json') };
}

/** Exact historical target only. Retire the loose copy only after full extraction
 * and content/permission verification; preserve the complete physical rollback. */
export async function archiveBackup(repoRoot, { execute = false, retire = false, progress = () => {} } = {}) {
  assert.ok(!retire || execute, 'Retirement requires explicit execution');
  const paths = archivePaths(repoRoot);
  assert.equal(await realpath(paths.parent), paths.parent, 'Backup parent must not be a symlink');
  assert.equal(await realpath(paths.source), paths.source, 'Backup must not be a symlink');
  const entries = await snapshotTree(paths.source);
  const sourceBytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  if (!execute) return { execute: false, sourceBytes, entries: entries.length, source: paths.source };
  await readFile(join(paths.source, 'README.md'));
  // A stopped physical cluster is a retention prerequisite, not proof of a
  // logical restore. Never start either the historical or active database.
  const control = await run('pg_controldata', [join(paths.source, 'rehearsal/postgres/data')]);
  assert.match(control, /Database cluster state:\s+shut down\s*$/m, 'Historical PostgreSQL must be stopped');
  try {
    await run('lsof', ['+D', paths.source]);
    throw new Error('A process still has the historical backup open');
  } catch (error) { if (error.exitCode !== 1) throw error; }
  for (const destination of [paths.archive, paths.manifest]) {
    await lstat(destination).then(() => { throw new Error('Archive destination already exists'); }, error => { if (error.code !== 'ENOENT') throw error; });
  }
  const lock = paths.archive + '.lock';
  await mkdir(lock, { mode: 0o700 });
  let scratch;
  const partial = paths.archive + '.' + process.pid + '.partial';
  try {
    progress('Compressing complete stopped snapshot');
    await writeFile(partial, '', { flag: 'wx', mode: 0o600 });
    await run('tar', ['--no-mac-metadata', '--zstd', '--options', 'zstd:compression-level=3,zstd:threads=2', '-cf', partial, '-C', paths.parent, BACKUP_NAME]);
    await chmod(partial, 0o600);
    scratch = await mkdtemp(join(tmpdir(), 'preformal-archive-verify-'));
    await chmod(scratch, 0o700);
    progress('Extracting and comparing every file and permission');
    await run('tar', ['-xpf', partial, '-C', scratch]);
    assert.deepEqual(await snapshotTree(join(scratch, BACKUP_NAME)), entries, 'Extracted backup differs from the original');
    assert.deepEqual(await snapshotTree(paths.source), entries, 'Source changed during archival');
    const archiveSha256 = await hashFile(partial), archiveBytes = (await lstat(partial)).size;
    await rename(partial, paths.archive);
    await writeFile(paths.manifest, JSON.stringify({ version: 1, backup: BACKUP_NAME, codeCheckpoint: '19af1f4', createdAt: new Date().toISOString(),
      archiveSha256, sourceBytes, archiveBytes, verification: 'full-extraction-content-and-permissions', entries }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    assert.equal(await hashFile(paths.archive), archiveSha256, 'Final archive changed');
    await syncPath(paths.archive);
    await syncPath(paths.manifest);
    await syncPath(paths.parent);
    if (retire) {
      progress('Retiring only the verified loose historical copy');
      assert.equal(await realpath(paths.source), paths.source);
      assert.deepEqual(await snapshotTree(paths.source), entries, 'Source changed before retirement');
      // Narrow literal basename and parent are fixed above; active rehearsal
      // and all unrelated backups are outside this removal target.
      await rm(paths.source, { recursive: true });
    }
    return { sourceBytes, archiveBytes, recoveredBytes: retire ? sourceBytes - archiveBytes : 0,
      archiveSha256, archive: paths.archive, manifest: paths.manifest, retiredLooseCopy: retire, entries: entries.length };
  } finally {
    if (scratch) await rm(scratch, { recursive: true });
    await rmdir(lock);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.every(arg => ['--execute', '--retire-uncompressed'].includes(arg)), 'Unsupported archive option');
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const result = await archiveBackup(repoRoot, { execute: args.includes('--execute'), retire: args.includes('--retire-uncompressed'), progress: value => console.log(value) });
  console.log(JSON.stringify(result, null, 2));
}

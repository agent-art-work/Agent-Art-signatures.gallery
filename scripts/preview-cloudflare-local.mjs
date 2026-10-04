import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// A local visual check of the exact public bundle. The canonical request URL
// is adapted here only; the deployed Worker never trusts a forwarded origin.
export async function loadPreviewArtifact(directory) {
  assert.ok(directory, 'An artifact directory is required.');
  const artifact = resolve(directory);
  const root = await lstat(artifact);
  assert.ok(root.isDirectory() && !root.isSymbolicLink(), 'Artifact must be a real directory, not a symlink.');
  const readArtifactFile = async path => {
    const segments = path.split('/');
    for (let index = 0; index < segments.length; index++) {
      const entry = await lstat(join(artifact, ...segments.slice(0, index + 1)));
      assert.ok(!entry.isSymbolicLink(), 'Artifact paths must not contain symlinks.');
      assert.ok(index === segments.length - 1 ? entry.isFile() : entry.isDirectory(),
        'Artifact inventory must name regular files within real directories.');
    }
    return readFile(join(artifact, path));
  };
  const manifest = JSON.parse(await readArtifactFile('manifest.json'));
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'Artifact manifest must be an object.');
  assert.equal(manifest.schema, 'signatures-gallery.preview-cloudflare.v1');
  assert.ok(['https://staging.signatures.gallery', 'https://signatures.gallery'].includes(manifest.origin));
  const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  assert.ok(isDigest(manifest.artifactSha256), 'Artifact Worker digest must be a lowercase SHA-256.');
  assert.ok(Array.isArray(manifest.files), 'Artifact files must be an inventory array.');
  const paths = new Set();
  // Validate all inventory metadata before reading files, and all file bytes
  // before importing executable code. Hashes prove consistency with this
  // manifest, not publisher authenticity; use a trusted, immutable artifact.
  for (const item of manifest.files) {
    assert.ok(item && typeof item === 'object' && !Array.isArray(item), 'Artifact inventory entries must be objects.');
    assert.ok(typeof item.path === 'string' && /^[a-zA-Z0-9._/-]+$/.test(item.path)
      && item.path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'),
      'Artifact paths must be canonical relative file paths.');
    assert.ok(!paths.has(item.path), 'Artifact inventory paths must be unique.');
    paths.add(item.path);
    assert.ok(Number.isSafeInteger(item.bytes) && item.bytes >= 0, 'Artifact byte counts must be non-negative safe integers.');
    assert.ok(isDigest(item.sha256), 'Artifact file digests must be lowercase SHA-256 values.');
  }
  assert.ok(paths.has('worker.mjs'), 'Artifact inventory must include worker.mjs exactly once.');
  const workerItem = manifest.files.find(item => item.path === 'worker.mjs');
  assert.equal(workerItem.sha256, manifest.artifactSha256, 'Artifact Worker digests must agree.');
  const mime = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
  const assets = new Map();
  for (const item of manifest.files) {
    const bytes = await readArtifactFile(item.path);
    assert.equal(bytes.length, item.bytes, 'Artifact differs from its manifest: byte count.');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256, 'Artifact differs from its manifest.');
    // Cloudflare consumes this configuration file; it is never a public asset.
    // Its integrity is still checked above, including in the local adapter.
    if (item.path === 'public/_headers') continue;
    if (item.path.startsWith('public/')) {
      const extension = /\.[a-z0-9]+$/.exec(item.path)?.[0];
      assert.ok(mime[extension], 'Unknown public file type.');
      assets.set('/' + item.path.slice('public/'.length), { bytes, type: mime[extension] });
    }
  }
  const { default: worker } = await import(pathToFileURL(join(artifact, 'worker.mjs')).href);
  const env = { PUBLIC_ORIGIN: manifest.origin, ASSETS: { async fetch(request) {
    const file = assets.get(new URL(request.url).pathname);
    return file ? new Response(file.bytes, { headers: { 'Content-Type': file.type } }) : new Response(null, { status: 404 });
  } } };
  return { worker, env, publicOrigin: manifest.origin };
}

/** A temporary loopback inspector, not a production server or supervisor. */
export async function startPreviewLocal({ directory, port = 3010 } = {}) {
  assert.ok(Number.isSafeInteger(port) && (port === 0 || port >= 1024) && port <= 65535);
  const { worker, env, publicOrigin } = await loadPreviewArtifact(directory);
  let localOrigin;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.host, new URL(localOrigin).host);
      assert.ok((req.url?.length ?? 0) <= 2048);
      const local = new URL(req.url, localOrigin);
      assert.equal(local.origin, localOrigin);
      const request = new Request(publicOrigin + local.pathname + local.search, { method: req.method });
      const response = await worker.fetch(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(400); res.end('Invalid local preview request.'); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  localOrigin = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return { localOrigin, publicOrigin, close };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [directory, portInput = '3010'] = process.argv.slice(2);
  startPreviewLocal({ directory, port: Number(portInput) }).then(site => {
    console.log(JSON.stringify({ localOrigin: site.localOrigin, publicOrigin: site.publicOrigin, mintingEnabled: false }));
    const stop = () => { void site.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

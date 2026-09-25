import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import canonicalize from "canonicalize";
import { candidateSnapshot, verifyRelease } from "../contracts/tools/generative-release.mjs";
import { GENERATIVE_DATABASE_V2_LOCK, GENERATIVE_DATABASE_V2_MIGRATIONS } from "../src/openMint/persistence/databaseSchemaV2Lock.ts";

const sourceRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = () => { throw Error("Staging release build unavailable."); };
const safe = name => typeof name === "string" && name.length < 256 && !name.startsWith("/")
  && !name.includes("\\") && name.split("/").every(part => part && part !== "." && part !== "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !isAbsolute(args[1]) || resolve(args[1]) !== args[1]
  || args[1] === sep || existsSync(args[1])) fail();
const destination = args[1];

// Verify the source lock before copying; this builder never regenerates it.
verifyRelease(sourceRoot);
const snapshot = candidateSnapshot(sourceRoot);
const proof = new Set([
  "contracts/releases/generative-v1-rc1.json", "contracts/foundry.toml", "package-lock.json",
  "contracts/src/release/SignatureRendererV1RC1.sol", "contracts/src/release/GenerativeSignaturesV1RC1.sol",
  "contracts/src/experimental/SignatureRendererCandidate.sol", "reference/algorithm-v2.0.0/renderer-lock.json",
  ...Object.keys(JSON.parse(readFileSync(join(sourceRoot, "reference/algorithm-v2.0.0/renderer-lock.json"), "utf8")).files),
]);
for (const migration of GENERATIVE_DATABASE_V2_MIGRATIONS) {
  const name = resolve(sourceRoot, "src/openMint/persistence", migration.path);
  assert.ok(name.startsWith(join(sourceRoot, "src/openMint") + sep));
  assert.equal(sha(readFileSync(name)), migration.sha256);
  proof.add(relative(sourceRoot, name));
}
for (const name of ["SignatureRendererV1RC1", "GenerativeSignaturesV1RC1"]) {
  const artifactPath = `contracts/out/${name}.sol/${name}.json`;
  proof.add(artifactPath);
  const artifact = JSON.parse(readFileSync(join(sourceRoot, artifactPath), "utf8"));
  for (const original of Object.keys(artifact.metadata.sources)) {
    assert.match(original, /^src\/release\/(?:SignatureRendererV1RC1|GenerativeSignaturesV1RC1)\.sol$|^\.\.\/node_modules\/@openzeppelin\/contracts\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.sol$/);
    proof.add(`contracts/${original}`);
  }
}

const copyOne = raw => {
  const name = raw.replace(/^contracts\/\.\.\//, "");
  assert.ok(safe(name));
  const from = resolve(sourceRoot, name), to = resolve(destination, name);
  assert.ok(from.startsWith(sourceRoot + sep) && to.startsWith(destination + sep));
  const stat = lstatSync(from);
  assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 32_000_000);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { dereference: false, errorOnExist: true, force: false });
};

function copyTree(name) {
  assert.ok(safe(name));
  const root = resolve(sourceRoot, name);
  assert.ok(root.startsWith(sourceRoot + sep));
  const walk = path => {
    const stat = lstatSync(path);
    assert.ok(!stat.isSymbolicLink());
    if (stat.isDirectory()) { for (const entry of readdirSync(path).sort()) walk(join(path, entry)); return; }
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 32_000_000);
    copyOne(relative(sourceRoot, path));
  };
  walk(root);
}

mkdirSync(join(destination, "bin"), { recursive: true });
const compiled = await build({
  entryPoints: [join(sourceRoot, "contracts/tools/generative-staging-bootstrap.mjs")],
  bundle: true, platform: "node", format: "cjs", target: "node22", external: ["sharp"],
  outfile: join(destination, "bin/staging.cjs"), logLevel: "silent", metafile: true,
  banner: { js: 'const __r5_import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
  define: { "import.meta.url": "__r5_import_meta_url" },
});
const sourceFiles = Object.keys(compiled.metafile.inputs).map(input => resolve(sourceRoot, input))
  .filter(input => input.startsWith(sourceRoot + sep) && !input.startsWith(join(sourceRoot, "node_modules") + sep))
  .map(input => relative(sourceRoot, input)).sort();
assert.ok(sourceFiles.length > 50 && sourceFiles.includes("contracts/tools/generative-staging-bootstrap.mjs"));
const sourceSnapshotSha256 = sha(canonicalize(sourceFiles.map(path => ({ path, sha256: sha(readFileSync(join(sourceRoot, path))) }))));
for (const name of [...proof].sort()) copyOne(name);

// sharp is the only external runtime package. Copy just its declared current
// platform dependency closure, including the binary, after refusing links.
const platform = `${process.platform}-${process.arch}`;
const sharp = JSON.parse(readFileSync(join(sourceRoot, "node_modules/sharp/package.json"), "utf8"));
assert.equal(sharp.version, "0.35.4");
for (const name of ["sharp", ...Object.keys(sharp.dependencies).sort(), `@img/sharp-${platform}`, `@img/sharp-libvips-${platform}`]) {
  const packageDir = `node_modules/${name}`;
  if (!existsSync(join(sourceRoot, packageDir))) fail();
  copyTree(packageDir);
}
for (const name of ["package.json", "LICENSE", "wght.css", "wght-italic.css",
  ...["latin", "latin-ext"].flatMap(subset => ["normal", "italic"].map(style => `files/instrument-sans-${subset}-wght-${style}.woff2`))]) {
  copyOne(`node_modules/@fontsource-variable/instrument-sans/${name}`);
}

const files = [];
const enumerate = directory => {
  for (const entry of readdirSync(join(destination, directory)).sort()) {
    const name = directory ? `${directory}/${entry}` : entry;
    if (name === "release-manifest.json") continue;
    const stat = lstatSync(join(destination, name));
    assert.ok(!stat.isSymbolicLink());
    if (stat.isDirectory()) enumerate(name);
    else { assert.ok(stat.isFile() && safe(name)); files.push({ path: name, bytes: stat.size, sha256: sha(readFileSync(join(destination, name))) }); }
  }
};
enumerate("");
const manifest = { schema: "sg-staging-release-package-v1", status: "candidate-not-approved",
  nodeMajor: Number(process.versions.node.split(".")[0]), platform: process.platform, architecture: process.arch,
  dependencyLockSha256: sha(readFileSync(join(sourceRoot, "package-lock.json"))),
  databaseProfile: GENERATIVE_DATABASE_V2_LOCK,
  releaseLockSha256: sha(readFileSync(join(sourceRoot, "contracts/releases/generative-v1-rc1.json"))),
  sourceSnapshotSha256, releaseSnapshotSha256: sha(canonicalize(snapshot)), files };
writeFileSync(join(destination, "release-manifest.json"), `${canonicalize(manifest)}\n`, { flag: "wx", mode: 0o444 });
console.log(JSON.stringify({ package: basename(destination), manifestSha256: sha(canonicalize(manifest)), files: files.length,
  status: manifest.status }));

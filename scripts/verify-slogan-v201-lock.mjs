import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCK_PATH = "reference/algorithm-v2.0.1/slogan-lock.json";
const SOURCE_DIRECTORY = "reference/algorithm-v2.0.1";
const PYTHON_PATH = `${SOURCE_DIRECTORY}/signature_renderer_v2.0.1.py`;
const SPEC_PATH = `${SOURCE_DIRECTORY}/signature_renderer_v2.0.1.json`;
const SUMS_PATH = `${SOURCE_DIRECTORY}/SHA256SUMS`;
const SNAPSHOT_PATH = "src/brand/sloganMbtiFrames.ts";
const UPSTREAM_HASHES = {
  [PYTHON_PATH]: "bfa7ebdfb6e5ced7ddc0b92c3facb3709863ee6c6d10cf9a2f1596c018ecb896",
  [SPEC_PATH]: "c305da7492b26749e9d4e88c4b0cb4de4deb1f654f334a6aaa6abe367078faa6",
  [SUMS_PATH]: "1f04082c2cc02dfefb03864519021d67ec3be874d72ea65cf327eab8861c57e0",
};
const PROTECTED_PATHS = [...Object.keys(UPSTREAM_HASHES), "scripts/capture-slogan-v2.py", SNAPSHOT_PATH];
const UPSTREAM = {
  repository: "https://github.com/inshell-art/agent-art-Signature-prototype",
  tag: "v2.0.1",
  tagObject: "5c68785c9723cd2cd9175d0283ee22d7cfcd6fc3",
  commit: "d00c018d1a740a5807480126d1f1bd0c620fb96d",
};
const EXPECTED_SOURCE = {
  displayText: "Anyone_Can_Sign_Anyone",
  rendererVersion: "sg-renderer-2.0.1",
  upstreamCommit: UPSTREAM.commit,
  pythonSha256: UPSTREAM_HASHES[PYTHON_PATH],
  adapter: "brand-only-whole-phrase-v2",
};
const ADOPTION = {
  scope: "brand-slogan-only",
  accountRendererVersion: "sg-renderer-2.0.0",
  legacyRendererVersion: "sg-renderer-1.0.0",
};
const readRepositoryFile = path => readFileSync(new URL(`../${path}`, import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

// Parse only the capture script's generated literal format. Do not execute the
// module: injected reads must verify the supplied bytes, not a cached TS import.
function snapshotLiteral(text) {
  return JSON.parse(text.replace(/^(\s*)([A-Za-z_]\w*):/gm, '$1"$2":').replace(/,\s*}/g, "}"));
}

function snapshotExport(text, name, opening, closing) {
  const match = text.match(new RegExp(`^export const ${name} = Object\\.freeze\\((${opening}[\\s\\S]*?${closing}) as const\\);$`, "m"));
  assert.ok(match, `Missing generated slogan export: ${name}.`);
  return match[1];
}

function readSnapshot(text) {
  const source = snapshotLiteral(snapshotExport(text, "SLOGAN_MBTI_SOURCE", "\\{", "\\}"));
  const layout = snapshotLiteral(snapshotExport(text, "SLOGAN_MBTI_LAYOUT", "\\{", "\\}"));
  const frameText = snapshotExport(text, "SLOGAN_MBTI_FRAMES", "\\[", "\\]").slice(1, -1);
  const frames = [];
  const remaining = frameText.replace(/  Object\.freeze\((\{[\s\S]*?\}) as const\),/g, (_, literal) => {
    frames.push(snapshotLiteral(literal));
    return "";
  });
  assert.equal(remaining.trim(), "", "Unsupported generated slogan frame format.");
  return { source, layout, frames };
}

/** Read-only release gate. Updating hashes never adopts a different upstream release. */
export function verifySloganV201Lock({ read = readRepositoryFile } = {}) {
  const lock = JSON.parse(read(LOCK_PATH).toString());
  assert.equal(lock.schema, "signatures-gallery-slogan-lock/1");
  assert.equal(lock.status, "pinned");
  assert.deepEqual(lock.upstream, UPSTREAM, "Slogan v2.0.1 release identity changed.");
  assert.equal(lock.algorithmVersion, "2.0.1");
  assert.equal(lock.rendererVersion, EXPECTED_SOURCE.rendererVersion);
  assert.deepEqual(lock.adoption, ADOPTION, "Slogan v2.0.1 adoption must remain brand-only.");
  assert.deepEqual(lock.source, EXPECTED_SOURCE, "Slogan v2.0.1 capture identity changed.");
  assert.equal(lock.verification.ownerVisualApproval, "Not asserted; ready for review");
  assert.deepEqual(Object.keys(lock.files).sort(), [...PROTECTED_PATHS].sort(), "Incomplete v2.0.1 slogan protected source list.");
  const files = new Map();
  for (const path of PROTECTED_PATHS) {
    const bytes = read(path);
    assert.equal(hash(bytes), lock.files[path], `Pinned v2.0.1 slogan source changed: ${path}. Adopt a reviewed snapshot.`);
    files.set(path, bytes.toString());
  }
  for (const [path, expected] of Object.entries(UPSTREAM_HASHES)) {
    assert.equal(lock.files[path], expected, `Slogan v2.0.1 upstream identity changed: ${path}.`);
  }
  for (const path of [PYTHON_PATH, SPEC_PATH]) {
    assert.ok(files.get(SUMS_PATH).split("\n").includes(`${UPSTREAM_HASHES[path]}  ${path.slice(SOURCE_DIRECTORY.length + 1)}`), "Upstream slogan checksum manifest differs.");
  }

  const spec = JSON.parse(files.get(SPEC_PATH));
  assert.equal(spec.algorithm.version, lock.algorithmVersion);
  assert.equal(spec.external_text_curve_reuse.changes_signature_input_contract, false);
  assert.equal(spec.algorithm.input.x_handle.pattern, "^[A-Za-z0-9_]{1,15}$");
  const policy = spec.external_text_curve_reuse;
  const characterCount = EXPECTED_SOURCE.displayText.length;
  const span = policy.reference_segment_width * (characterCount - 1);
  const width = span + 2 * policy.horizontal_margin_each_side;
  const outputHeight = spec.algorithm.input.output_height.default;
  const expectedLayout = {
    extended: true,
    character_count: characterCount,
    reference_character_limit: policy.signature_character_limit,
    segment_width: policy.reference_segment_width,
    curve_span: span,
    canonical_width: width,
    canonical_height: policy.canonical_height,
    proportional_output_width: Math.round(outputHeight * width / policy.canonical_height),
    proportional_output_height: outputHeight,
  };
  assert.deepEqual(lock.layout, expectedLayout, "Slogan layout differs from the upstream long-text policy.");
  const snapshot = readSnapshot(files.get(SNAPSHOT_PATH));
  assert.deepEqual(snapshot.source, EXPECTED_SOURCE, "Slogan snapshot capture identity changed.");
  assert.deepEqual(snapshot.layout, expectedLayout, "Slogan snapshot layout differs from the upstream long-text policy.");
  const mbtiOrder = spec.algorithm.input.mbti_type.values.slice(0, 8);
  assert.equal(lock.frames.length, 8, "Incomplete v2.0.1 slogan frame lock.");
  assert.equal(snapshot.frames.length, 8, "Incomplete v2.0.1 slogan snapshot.");
  for (const [index, mbti] of mbtiOrder.entries()) {
    const frame = snapshot.frames[index];
    assert.deepEqual(Object.keys(frame).sort(), ["d", "mbti", "pairedMbti", "sha256"], "Unexpected slogan frame fields.");
    assert.equal(frame.mbti, mbti, "Slogan MBTI frame order changed.");
    assert.equal(frame.pairedMbti, `E${mbti.slice(1)}`, "Slogan I/E frame pair changed.");
    assert.match(frame.d, /^M[0-9.,CL \-]+Z$/, `Invalid captured slogan path: ${mbti}.`);
    assert.equal(hash(frame.d), frame.sha256, `Slogan frame path hash differs: ${mbti}.`);
    assert.deepEqual(lock.frames[index], { mbti, pairedMbti: frame.pairedMbti, sha256: frame.sha256 }, `Slogan frame differs from the locked capture: ${mbti}.`);
  }
  assert.equal(new Set(snapshot.frames.map(frame => frame.sha256)).size, 8, "Slogan requires eight distinct geometries.");
  return { rendererVersion: EXPECTED_SOURCE.rendererVersion, scope: ADOPTION.scope, sourceFiles: PROTECTED_PATHS.length, frames: snapshot.frames.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifySloganV201Lock();
    console.log(`Slogan lock verified: ${result.rendererVersion}; ${result.scope}; ${result.sourceFiles} source files; ${result.frames} captured frames.`);
  } catch (error) {
    console.error(`Slogan v2.0.1 lock FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}

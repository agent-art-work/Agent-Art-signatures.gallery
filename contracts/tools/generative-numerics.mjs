import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GENERATIVE_READ_LIMITS } from "../../src/openMint/generativeReadLimits.ts";
import { RELEASE, ROOT, verifyRelease } from "./generative-release.mjs";

const Q = 10n ** 18n;
const PI = 3141592653589793238n;
const base64Bytes = size => 4 * Math.ceil(size / 3);

/** Count the actual _digits push topology, independently of its L+D+R bound. */
export function topology(length, mask) {
  assert.ok(Number.isInteger(length) && length >= 1 && length <= 15, "handle length");
  assert.ok(Number.isInteger(mask) && mask >= 0 && mask < 2 ** length, "digit mask");
  if (mask === 0) return { points: Math.max(2, length), digits: 0, runs: 0 };
  let points = 0, digits = 0, runs = 0;
  for (let i = 0; i < length; i++) {
    if (mask & (1 << i)) {
      digits++;
      if (i === 0 || !(mask & (1 << (i - 1)))) { points++; runs++; }
      points += 2;
    } else points++;
  }
  return { points, digits, runs };
}

// Deliberately NOT a Solidity parser. These exact source slices are protected
// by verifyRelease. Fail on escapes rather than silently miscounting literals.
function literalBytes(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, "locked function boundaries");
  const literals = [...source.slice(from, to).matchAll(/'([^']*)'/g)];
  assert.ok(literals.length > 0, "locked string literals");
  return literals.reduce((sum, [, literal]) => {
    assert.ok(!literal.includes("\\"), "escaped literal requires worksheet review");
    return sum + Buffer.byteLength(literal);
  }, 0);
}

/** Arithmetic worksheet, not an abstract interpreter or a formal EVM proof.
 * See docs/generative-numerical-security-review.md for every manual premise.
 * The source lock is verified before applying those premises; nothing here
 * grants runtime admission, audit approval or a universal gas/parity claim.
 */
export function numericalWorksheet(root = ROOT) {
  const release = verifyRelease(root);
  const renderer = readFileSync(resolve(root, "contracts/src/release/SignatureRendererV1RC1.sol"), "utf8");
  const collection = readFileSync(resolve(root, "contracts/src/release/GenerativeSignaturesV1RC1.sol"), "utf8");
  let topologyCases = 0, maxPoints = 0;
  for (let length = 1; length <= 15; length++) for (let mask = 0; mask < 2 ** length; mask++) {
    const t = topology(length, mask);
    if (mask) {
      assert.equal(t.points, length + t.digits + t.runs);
      assert.ok(t.runs <= length - t.digits + 1);
      assert.ok(t.points <= 2 * length + 1);
    }
    assert.ok(t.points >= 2 && t.points <= 31);
    maxPoints = Math.max(maxPoints, t.points); topologyCases++;
  }
  let sampledHalf = 0, sampledMaxAtPoints = [];
  for (let m = 2; m <= maxPoints; m++) {
    const n = Math.max(8, Math.min(32, Math.ceil(240 / m)));
    const count = (m - 1) * n;
    if (count > sampledHalf) { sampledHalf = count; sampledMaxAtPoints = [m]; }
    else if (count === sampledHalf) sampledMaxAtPoints.push(m);
  }
  // Triangle-inequality bound on all 21 fixed-point sine terms, with the
  // same toward-zero divisions as Solidity (all bounds below are positive).
  const xx = PI * PI / Q;
  let term = PI, absoluteSineBound = term;
  for (let n = 1n; n <= 20n; n++) {
    term = (term * xx / Q) / ((2n * n) * (2n * n + 1n));
    absoluteSineBound += term;
  }
  assert.ok(absoluteSineBound < 12n * Q);
  const raw = 360n * Q + 120n * 12n * Q; // anchors + seed displacement
  const centered = 2n * raw + 210n * Q;
  const halfWidth = 15n * Q / 2n;
  const finalControls = centered + 210n * Q + centered + halfWidth;
  assert.ok(finalControls <= 7838n * Q);
  const offset = 7838n * Q + halfWidth;
  assert.ok(offset <= 7846n * Q);
  const bezierControl = 6n * 7846n * Q;
  const geometryIntermediate = 1_000_000n * Q;
  assert.ok(108n * 7846n * Q < geometryIntermediate); // _through numerator
  const productOrSquareSum = 2n * geometryIntermediate ** 2n;
  assert.ok(productOrSquareSum < 2n ** 255n - 1n);
  assert.ok(7846n * Q + Q / 200n < 10000n * Q);
  assert.ok(bezierControl + Q / 200n < 100000n * Q);
  const sampledVertices = 2 * sampledHalf + 2;
  const bezierCurves = 2 * (maxPoints - 1);
  const sampledPathBytes = sampledVertices * (1 + 8 * 2 + 1) + 1;
  const bezierPathBytes = 2 * (1 + 9 * 2 + 1) + bezierCurves * (1 + 3 * (9 * 2 + 1) + 2) + 1;
  assert.ok(sampledPathBytes < 16384, "_sampled buffer");
  const svgStaticBytes = literalBytes(renderer, "    function render(", "\n}");
  const svgBytes = Math.max(sampledPathBytes, bezierPathBytes) + svgStaticBytes + 3 * 7 + 15;
  const metadataStaticBytes = literalBytes(collection, "    function tokenURI(", "    function contractURI(");
  const metadataJsonBytes = metadataStaticBytes + 2 * 15 + 2 * 4
    + Buffer.byteLength(RELEASE.renderer) + Buffer.byteLength(RELEASE.inputProfile)
    + 2 * 66 + base64Bytes(svgBytes);
  const tokenUriBytes = Buffer.byteLength("data:application/json;base64,") + base64Bytes(metadataJsonBytes);
  const artworkAbiBytes = 64 + 32 * Math.ceil(tokenUriBytes / 32);
  assert.ok(svgBytes < GENERATIVE_READ_LIMITS.svgBytes, "SVG read limit");
  assert.ok(metadataJsonBytes < GENERATIVE_READ_LIMITS.metadataJsonBytes, "JSON read limit");
  assert.ok(artworkAbiBytes < GENERATIVE_READ_LIMITS.artworkAbiBytes, "ABI read limit");
  return {
    schema: "sg-generative-numerical-worksheet-v1", status: "internal-conditional-bounds-not-admission",
    releaseLockSha256: release.releaseLockSha256, readLimitsVersion: GENERATIVE_READ_LIMITS.version,
    structure: { topologyCases, maxPoints, centerOutlineEvaluations: (maxPoints - 1) * 65,
      sampledHalf, sampledMaxAtPoints, sampledVertices, bezierCurves, bezierOffsetEvaluations: bezierCurves * 4 + 2 },
    arithmetic: { scale: Q.toString(), absoluteSineBound: absoluteSineBound.toString(),
      rawCoordinateBound: raw.toString(), centeredCoordinateBound: centered.toString(),
      finalControlBound: (7838n * Q).toString(), offsetBound: (7846n * Q).toString(),
      bezierControlBound: bezierControl.toString(), geometryIntermediateBound: geometryIntermediate.toString(),
      productOrSquareSumBound: productOrSquareSum.toString(), int256Max: (2n ** 255n - 1n).toString() },
    output: { sampledPathBytes, bezierPathBytes, svgStaticBytes, svgBytes,
      metadataStaticBytes, metadataJsonBytes, tokenUriBytes, artworkAbiBytes },
    formalProgramProof: false, universalGasBound: false, universalOracleParity: false,
    independentSecurityApproval: false, runtimeAdmissionAllowed: false,
  };
}

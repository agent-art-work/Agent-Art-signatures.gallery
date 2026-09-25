import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, createWalletClient, http, keccak256, stringToHex, encodeAbiParameters, encodeFunctionData, numberToHex } from "viem";
import { privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { MBTI_TYPES, renderSignatureSvg } from "../src/algorithmV2/index.ts";
import { verifyRendererV2Lock } from "./verify-renderer-v2-lock.mjs";
import { RELEASE, verifyRelease } from "../contracts/tools/generative-release.mjs";
import { decodeArtworkDataUri, decodeBoundedRead, GENERATIVE_READ_LIMITS as LIMITS } from "../src/openMint/generativeReadLimits.ts";

// Diagnostic only. No environment credentials, provider calls, existing chain,
// database or wallet. No renderer adoption or new golden blessing.
if (!process.argv.includes("--execute-local-test-transactions")) throw new Error("Explicit local test opt-in required.");
const releaseCandidate = process.argv.includes("--release-candidate");
const releaseEvidence = releaseCandidate ? verifyRelease() : null;
const rendererName = releaseCandidate ? "SignatureRendererV1RC1" : "SignatureRendererCandidate";
const collectionName = releaseCandidate ? "GenerativeSignaturesV1RC1" : "GenerativeSignaturesCandidate";
const sourceDirectory = releaseCandidate ? "release" : "experimental";
const inputProfile = releaseCandidate ? RELEASE.inputProfile : "sg-generative-inputs-experimental-1";
const domainName = releaseCandidate ? RELEASE.domainName : "SignaturesGenerativeMintExperimental";
verifyRendererV2Lock();
const quick = process.argv.includes("--quick");
const readLimits = process.argv.includes("--read-limits");
if (readLimits && (!releaseCandidate || !quick || !process.argv.includes("--mint") || process.argv.includes("--backend")))
  throw new Error("Read-limit campaign requires the candidate, --quick and --mint; keep backend rehearsal separate.");
const output = new URL("../.local/generative-renderer/", import.meta.url);
await mkdir(output, { recursive: true });
const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
// Isolated node ceiling. Individual rendering calls below have a stricter 30m
// research budget; this does not establish any external provider's limits.
const child = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--gas-limit", "200000000", "--silent"], { stdio: "ignore" });
let startupError; child.on("error", error => { startupError = error; });
const transport = http(`http://127.0.0.1:${port}`, { retryCount: 0, timeout: 30000 });
const client = createPublicClient({ chain: foundry, transport });
// Public Anvil test key only; never used against a remote URL.
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const wallet = createWalletClient({ chain: foundry, transport, account });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const cases = new Map();
const add = (h, m) => cases.set(`${h}/${m}`, [h, m]);
for (const h of ["x", "karpathy", "Alice_Bob_Key", "ABCDEFGHIJKLMNO", "012345678901234", "_______________"])
  for (const m of MBTI_TYPES) add(h, m);
if (!quick) {
  for (const alphabet of ["ABCDEFGHIJKLMNO", "abcdefghijklmno", "_______________", "Ab_123zXY_456pq7", "012345678901234"])
    for (let length = 1; length <= 15; length++) for (const m of MBTI_TYPES) add(alphabet.slice(0, length), m);
  for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_")
    for (const m of MBTI_TYPES) add(c, m);
  const goldens = JSON.parse(await readFile(new URL("../reference/algorithm-v2.0.0/golden-svgs.json", import.meta.url), "utf8"));
  for (const g of goldens) add(g.handle, g.mbti);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_";
  for (let index = 0; index < 256; index++) {
    const seed = createHash("sha256").update(`generative-renderer-survey-v1/${index}`).digest();
    const length = 1 + seed[0] % 15;
    let handle = "";
    for (let n = 0; n < length; n++) handle += alphabet[seed[n + 1] % alphabet.length];
    for (const m of MBTI_TYPES) add(handle, m);
  }
}
const report = { experimental: !releaseCandidate, releaseCandidate, releaseEvidence, activated: false, localOnly: true, realProviderCalls: 0, publicTransactions: 0,
  callGasCap: LIMITS.artworkGas, oracle: "locked sg-renderer-2.0.0 / canonical 1080 square", quick,
  cases: cases.size, exact: 0, mismatches: [], errors: [], gasSamples: [], maxReadMs: 0 };
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error("Isolated Anvil exited during startup.");
    try { assert.equal(await client.getChainId(), 31337); ready = true; break; } catch { await delay(100); }
  }
  assert.ok(ready);
  const build = JSON.parse(await readFile(new URL(`../contracts/out/${rendererName}.sol/${rendererName}.json`, import.meta.url), "utf8"));
  report.compiledSource = build.metadata.sources[`src/${sourceDirectory}/${rendererName}.sol`].keccak256;
  const sourceBytes = await readFile(new URL(`../contracts/src/${sourceDirectory}/${rendererName}.sol`, import.meta.url));
  report.sourceSha256 = hash(sourceBytes);
  assert.equal(report.compiledSource, keccak256(sourceBytes), "Rebuild stale renderer bytecode before rehearsal.");
  report.runtimeBytes = build.deployedBytecode.object.replace(/^0x/, "").length / 2;
  assert.ok(report.runtimeBytes <= 24576, "EIP-170 renderer runtime cap; do not disable enforcement");
  const deployed = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: build.abi, bytecode: build.bytecode.object }) });
  assert.equal(deployed.status, "success");
  assert.equal(await client.readContract({ address: deployed.contractAddress, abi: build.abi, functionName: "VERSION" }),
    releaseCandidate ? RELEASE.renderer : "experimental-fixed18-not-locked");
  assert.equal(keccak256(await client.getCode({ address: deployed.contractAddress })), keccak256(build.deployedBytecode.object));
  report.deploymentGas = String(deployed.gasUsed);
  let completed = 0;
  for (const [handle, mbti] of cases.values()) {
    const expected = renderSignatureSvg(handle, mbti);
    const input = { address: deployed.contractAddress, abi: build.abi, functionName: "render", args: [handle, mbti], gas: BigInt(report.callGasCap) };
    try {
      const started = performance.now();
      const actual = await client.readContract(input);
      report.maxReadMs = Math.max(report.maxReadMs, Math.round(performance.now() - started));
      if (actual === expected) report.exact++;
      else {
        const path = svg => /<path d="([^"]+)"/.exec(svg)?.[1] ?? "";
        const numbers = svg => (path(svg).match(/-?\d+\.\d+/g) ?? []).map(Number);
        const a = numbers(actual), b = numbers(expected);
        let first = 0; while (first < Math.min(actual.length, expected.length) && actual[first] === expected[first]) first++;
        report.mismatches.push({ handle, mbti, expectedSha256: hash(expected), actualSha256: hash(actual),
          expectedBytes: Buffer.byteLength(expected), actualBytes: Buffer.byteLength(actual),
          sameCommands: path(actual).replace(/-?\d+\.\d+/g, "#") === path(expected).replace(/-?\d+\.\d+/g, "#"),
          maxCoordinateDelta: a.length === b.length ? Math.max(0, ...a.map((v, i) => Math.abs(v - b[i]))) : null,
          firstDifference: first, expectedExcerpt: expected.slice(Math.max(0, first - 20), first + 60), actualExcerpt: actual.slice(Math.max(0, first - 20), first + 60) });
        if (report.mismatches.length <= 12) {
          await writeFile(new URL(`${handle}-${mbti}-expected.svg`, output), expected);
          await writeFile(new URL(`${handle}-${mbti}-candidate.svg`, output), actual);
        }
      }
      if (mbti === "INTJ" || mbti === "INFP") {
        if (["x", "karpathy", "Alice_Bob_Key", "ABCDEFGHIJKLMNO", "012345678901234"].includes(handle)) {
          report.gasSamples.push({ handle, mbti, svgBytes: Buffer.byteLength(actual),
            readExecutionGas: String(await client.estimateContractGas(input)) });
        }
      }
    } catch (error) { report.errors.push({ handle, mbti, error: String(error.shortMessage ?? error.message).slice(0, 300) }); }
    completed++;
    if (completed % 32 === 0) console.log(JSON.stringify({ completed, total: cases.size, exact: report.exact, mismatches: report.mismatches.length, errors: report.errors.length }));
  }
  if (!report.errors.length && !report.mismatches.length && process.argv.includes("--mint")) {
    const mintBuild = JSON.parse(await readFile(new URL(`../contracts/out/${collectionName}.sol/${collectionName}.json`, import.meta.url), "utf8"));
    assert.equal(mintBuild.metadata.sources[`src/${sourceDirectory}/${collectionName}.sol`].keccak256,
      keccak256(await readFile(new URL(`../contracts/src/${sourceDirectory}/${collectionName}.sol`, import.meta.url))), "Rebuild stale mint bytecode before rehearsal.");
    const testRole = addressIndex => mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex });
    const signer = releaseCandidate ? testRole(5) : privateKeyToAccount(`0x${"1".padStart(64, "0")}`); // public offline test keys only
    const roles = releaseCandidate ? [1, 2, 3, 4].map(i => testRole(i).address) : [account.address,
      "0x000000000000000000000000000000000000a002", "0x000000000000000000000000000000000000a003", "0x000000000000000000000000000000000000a004"];
    const deployCollection = async () => {
      const receipt = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: mintBuild.abi,
        bytecode: mintBuild.bytecode.object, args: [deployed.contractAddress, 172800, ...roles, signer.address] }) });
      assert.equal(receipt.status, "success");
      const read = functionName => client.readContract({ address: receipt.contractAddress, abi: mintBuild.abi, functionName });
      assert.equal(await read("INPUT_PROFILE"), inputProfile);
      assert.equal(await read("paused"), releaseCandidate);
      if (releaseCandidate) {
        assert.equal(await read("VERSION"), RELEASE.collection);
        assert.equal((await read("defaultAdmin")).toLowerCase(), roles[0].toLowerCase());
        assert.equal((await read("trustedAuthorizer")).toLowerCase(), signer.address.toLowerCase());
        assert.equal(await read("defaultAdminDelay"), 172800);
        assert.equal((await read("renderer")).toLowerCase(), deployed.contractAddress.toLowerCase());
        const uri = await read("contractURI");
        assert.ok(uri.startsWith("data:application/json;base64,"));
        assert.equal(JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString()).name, "Signatures Gallery");
        const pauser = createWalletClient({ chain: foundry, transport, account: testRole(3) });
        const activation = await client.waitForTransactionReceipt({ hash: await pauser.writeContract({ address: receipt.contractAddress,
          abi: mintBuild.abi, functionName: "unpauseMinting" }) });
        assert.equal(activation.status, "success"); assert.equal(await read("paused"), false);
        report.localActivation = "Explicit test-only pauser transaction; no public activation";
      }
      return receipt;
    };
    const mintMbtis = readLimits ? MBTI_TYPES : ["INTJ", "INFP"];
    const mintHandles = readLimits ? ["x", "karpathy", "Alice_Bob_Key", "ABCDEFGHIJKLMNO", "012345678901234", "_______________",
      "000000000000000", "999999999999999", "a0a0a0a0a0a0a0a", "_0_0_0_0_0_0_0_", "A_z012345678901"]
      : ["x", "karpathy", "Alice_Bob_Key", "ABCDEFGHIJKLMNO", "012345678901234"];
    assert.equal(new Set(mintHandles.map(h=>h.toLowerCase())).size,mintHandles.length);
    assert.ok(mintHandles.every(h=>/^[A-Za-z0-9_]{1,15}$/.test(h)),"read-limit corpus must use legal handles");
    const collections = [];
    for (const _ of mintMbtis) collections.push(await deployCollection());
    report.mintContractRuntimeBytes = mintBuild.deployedBytecode.object.replace(/^0x/, "").length / 2;
    assert.ok(report.mintContractRuntimeBytes <= 24576);
    report.mintContractDeploymentGas = String(collections[0].gasUsed);
    report.mints = [];
    const types = { GenerativeMintAuthorization: [
      { name: "handleKey", type: "bytes32" }, { name: "assessmentDigest", type: "bytes32" },
      { name: "inputDigest", type: "bytes32" }, { name: "recipient", type: "address" },
      { name: "nonce", type: "bytes32" }, { name: "issuedAt", type: "uint64" }, { name: "deadline", type: "uint64" },
    ] };
    if (readLimits) report.readLimits = { policy:LIMITS, corpusSha256:hash(JSON.stringify({handles:mintHandles,mbtis:mintMbtis})),
      cases:mintHandles.length*mintMbtis.length, maxTokenURIBytes:0, maxMetadataBytes:0, maxSvgBytes:0, maxAbiBytes:0,
      maxExecutionEstimate:0, maxElapsedMs:0, underGasCapRejected:0, publicProviderCompatibility:false, exhaustiveBound:false };
    for (const handle of mintHandles) {
      for (const [index, mbti] of mintMbtis.entries()) {
        const address = collections[index].contractAddress;
        const block = await client.getBlock();
        const rendererIdentity = await client.readContract({ address, abi: mintBuild.abi, functionName: "rendererIdentity" });
        const message = {
          handleKey: keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }], ["signatures.gallery/open-handle/v1", handle.toLowerCase()])),
          assessmentDigest: keccak256(stringToHex("OFFLINE FIXTURE ONLY: NO GROK ASSESSMENT")),
          inputDigest: keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "string" }, { type: "string" }],
            [inputProfile, rendererIdentity, handle, mbti])),
          recipient: account.address, nonce: keccak256(stringToHex(`local-generative-${handle}-${mbti}`)),
          issuedAt: block.timestamp, deadline: block.timestamp + 900n,
        };
        assert.equal(await client.readContract({ address, abi: mintBuild.abi, functionName: "inputDigest", args: [handle, mbti] }), message.inputDigest);
        const signature = await signer.signTypedData({ domain: { name: domainName, version: "1", chainId: 31337, verifyingContract: address },
          types, primaryType: "GenerativeMintAuthorization", message });
        const receipt = await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address, abi: mintBuild.abi, functionName: "mint", args: [handle, mbti, message, signature] }) });
        assert.equal(receipt.status, "success"); assert.ok(receipt.gasUsed < 350000n, "input-only mint budget");
        const input = { address, abi: mintBuild.abi, functionName: "tokenURI", args: [BigInt(message.handleKey)], gas: BigInt(report.callGasCap) };
        const started = performance.now();
        const raw = readLimits ? await client.request({method:"eth_call",params:[{to:address,
          data:encodeFunctionData({abi:mintBuild.abi,functionName:"tokenURI",args:[BigInt(message.handleKey)]}),
          gas:numberToHex(LIMITS.artworkGas)},{blockHash:receipt.blockHash,requireCanonical:true}]}) : undefined;
        const uri = readLimits ? decodeBoundedRead(mintBuild.abi,"tokenURI",raw,LIMITS.artworkAbiBytes) : await client.readContract(input);
        const elapsedMs = performance.now()-started;
        assert.ok(uri.startsWith("data:application/json;base64,"));
        const json = decodeArtworkDataUri(uri,"data:application/json;base64,",LIMITS.metadataJsonBytes),metadata = JSON.parse(json);
        assert.equal(metadata.name, `@${handle} × ${mbti}`);
        assert.ok(metadata.image.startsWith("data:image/svg+xml;base64,"));
        const svg=decodeArtworkDataUri(metadata.image,"data:image/svg+xml;base64,",LIMITS.svgBytes);
        assert.equal(svg, renderSignatureSvg(handle, mbti));
        assert.equal(metadata.properties.assessment_digest, message.assessmentDigest);
        assert.equal(metadata.properties.input_profile, inputProfile);
        assert.equal(metadata.properties.renderer, releaseCandidate ? RELEASE.renderer : "experimental-fixed18-not-locked");
        const execution = await client.estimateContractGas(input);
        report.mints.push({ handle, mbti, gasUsed: String(receipt.gasUsed), tokenURIBytes: Buffer.byteLength(uri),
          tokenURIExecutionGas: String(execution), svgExact: true });
        if(readLimits){
          const r=report.readLimits;
          for(const [field,value] of Object.entries({maxTokenURIBytes:Buffer.byteLength(uri),maxMetadataBytes:Buffer.byteLength(json),
            maxSvgBytes:Buffer.byteLength(svg),maxAbiBytes:(raw.length-2)/2,maxExecutionEstimate:Number(execution),maxElapsedMs:elapsedMs}))
            r[field]=Math.max(r[field],value);
          // This is finite sampled headroom, not a worst-case bound or a fee.
          assert.ok(execution<=BigInt(LIMITS.artworkGas)*9n/10n,"sample exceeded 90% of configured read gas ceiling");
          if(index===0){
            await assert.rejects(client.readContract({...input,gas:21000n}));r.underGasCapRejected++;
          }
        }
      }
      if(readLimits)console.log(`Metadata read limits: ${report.mints.length}/${report.readLimits.cases} exact and within budgets.`);
    }
    console.log("Input-only mint and chain-only metadata recovery passed; no SVG submitted or persisted.");
    if (process.argv.includes("--backend")) {
      const { rehearseGenerativeBackend } = await import("./generative-backend-rehearsal.mjs");
      report.backend = await rehearseGenerativeBackend({ client, wallet, account, signer, renderer: deployed.contractAddress,
        contractProfile: releaseCandidate ? "generative-v1-rc1" : "generative-experimental-v1", collection: collections[0], expectedSvg: renderSignatureSvg,
        visualTool: process.argv.includes("--visual-tool") ? process.argv[process.argv.indexOf("--visual-tool") + 1] : undefined,
        reviewFiles: process.argv.includes("--review-files") });
      console.log("Durable input authority, local mint and database-free recovery passed.");
    }
  }
  await writeFile(new URL(readLimits ? "release-read-limits.json" : `${releaseCandidate ? "release-" : ""}${quick ? "quick" : "survey"}.json`, output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, mismatches: report.mismatches.slice(0, 8), report: output.pathname }, null, 2));
  // A mismatch is research evidence, not a passing fidelity gate.
  if (report.errors.length || report.mismatches.length) process.exitCode = 2;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM"); await Promise.race([once(child, "exit"), delay(2000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

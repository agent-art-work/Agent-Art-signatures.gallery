import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, createWalletClient, http, keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { MBTI_TYPES, renderSignatureSvg } from "../src/algorithmV2/index.ts";
import { encodeOnchainArtifact } from "../src/openMint/onchainArtifact.ts";
import { ONCHAIN_MINT_ABI, onchainMintTypedData, onchainMintCalldata } from "../src/openMint/onchainAuthorization.ts";
import { openMintHandleKey } from "../src/openMint/authorization.ts";
import { createOnchainArtworkReader } from "../src/openMint/onchainReads.ts";

// No environment file or remote RPC is accepted. Own a fresh disposable Anvil;
// never touch the browser's chain, real providers, existing data or user wallet.
if (!process.argv.includes("--execute-local-test-transactions")) throw new Error("Explicit local test opt-in required.");
const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const child = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
let startupError; child.on("error", error => { startupError = error; });
const transport = http(`http://127.0.0.1:${port}`, { retryCount: 0, timeout: 3_000 });
const client = createPublicClient({ chain: foundry, transport });
// Public Anvil test key only. Never use this key on a public chain.
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const signer = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const wallet = createWalletClient({ chain: foundry, transport, account });
const artifact = JSON.parse(await readFile(new URL("../contracts/out/OnchainSignatures.sol/OnchainSignatures.json", import.meta.url), "utf8"));
const baseline = JSON.parse(await readFile(new URL("../contracts/out/OnchainSignatures.t.sol/OnchainStorageBaseline.json", import.meta.url), "utf8"));
const dataStore = JSON.parse(await readFile(new URL("../contracts/out/OnchainSignatures.t.sol/SvgStoreHarness.json", import.meta.url), "utf8"));
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error("Isolated Anvil exited during startup.");
    try { assert.equal(await client.getChainId(), 31337); ready = true; break; } catch { await delay(100); }
  }
  assert.ok(ready, "Isolated Anvil startup");
  const receipt = async hash => { const result = await client.waitForTransactionReceipt({ hash }); assert.equal(result.status, "success"); return result; };
  const deploy = async (build, args) => receipt(await wallet.deployContract({ abi: build.abi, bytecode: build.bytecode.object, args }));
  const deployed = await deploy(artifact, ["Signatures Gallery", "SG", 172800, account.address,
    "0x000000000000000000000000000000000000a002", "0x000000000000000000000000000000000000a003",
    "0x000000000000000000000000000000000000a004", signer.address]);
  const address = deployed.contractAddress;
  const baselineAddress = (await deploy(baseline, [])).contractAddress;
  const dataAddress = (await deploy(dataStore, [])).contractAddress;
  const domain = { chainId: 31337n, verifyingContract: address };
  const rows = [];
  // Two differently cased handles share a canonical identity: the second is
  // measured on a fresh collection, never by weakening uniqueness.
  const samples = [["x", "ENFP"], ["karpathy", "INTJ"], ["Alice_Bob_Key", "INFP"],
    ["ABCDEFGHIJKLMNO", "ENTP"], ["abcdefghijklmno", "ISFJ"], ["_______________", "ISTJ"]];
  let target = address;
  for (const [index, [handle, mbti]] of samples.entries()) {
    if (index === 4) target = (await deploy(artifact, ["Signatures Gallery", "SG", 172800, account.address,
      "0x000000000000000000000000000000000000a002", "0x000000000000000000000000000000000000a003",
      "0x000000000000000000000000000000000000a004", signer.address])).contractAddress;
    const svg = renderSignatureSvg(handle, mbti);
    const bundle = encodeOnchainArtifact({ renderHandle: handle, mbti, svg }, keccak256(stringToHex("OFFLINE TEST: NOT A GROK ASSESSMENT")));
    const block = await client.getBlock();
    const authorization = { handleKey: openMintHandleKey(bundle.canonicalHandle), assessmentDigest: bundle.assessmentDigest,
      artifactDigest: bundle.digest, recipient: account.address, tokenURIHash: bundle.tokenURIHash,
      nonce: keccak256(stringToHex(`local-case-${index}`)), issuedAt: block.timestamp, deadline: block.timestamp + 900n };
    const d = { ...domain, verifyingContract: target };
    const signature = await signer.signTypedData(onchainMintTypedData(d, authorization));
    const data = await onchainMintCalldata({ domain: d, authorization, artifact: bundle, signature, authorizer: signer.address });
    const minted = await receipt(await wallet.sendTransaction({ to: target, data }));
    const id = BigInt(authorization.handleKey);
    const uri = await client.readContract({ address: target, abi: ONCHAIN_MINT_ABI, functionName: "tokenURI", args: [id] });
    assert.equal(uri, bundle.tokenURI, "Solidity/TypeScript metadata byte parity");
    const metadata = JSON.parse(Buffer.from(uri.slice("data:application/json;base64,".length), "base64").toString());
    assert.equal(metadata.name, `@${handle} × ${mbti}`, "case-sensitive identity");
    assert.equal(Buffer.from(metadata.image.slice("data:image/svg+xml;base64,".length), "base64").toString(), svg, "chain-only original SVG");
    assert.equal(await client.readContract({ address: target, abi: ONCHAIN_MINT_ABI, functionName: "svg", args: [id] }), svg);
    if (index === 0) {
      // Same isolated Anvil behind two labelled test adapters is NOT proof of
      // production operator independence. It tests actual ABI/state recovery.
      const genesis = await client.getBlock({ blockNumber: 0n });
      const rpc = n => ({ id: `isolated-test-${n}`, request: (method, params) => client.request({ method, params }) });
      const reader = createOnchainArtworkReader({ config: { contractProfile: "onchain-v1", namespaceId: "isolated-test",
        deploymentId: "isolated-contract", chainId: 31337n, genesisHash: genesis.hash,
        deploymentBlock: { number: deployed.blockNumber, hash: deployed.blockHash }, contract: target,
        runtimeCodeHash: keccak256(await client.getCode({ address: target })), authorizer: signer.address,
        maxBlockAgeMs: 120000, maxFutureSkewMs: 5000, evidenceTtlMs: 10000, observationTimeoutMs: 30000 },
        rpcs: [rpc(0), rpc(1)] });
      const recovered = await reader(bundle.canonicalHandle, { number: minted.blockNumber, hash: minted.blockHash }, new AbortController().signal);
      assert.deepEqual(recovered.artifact, bundle, "reconstruct from chain without assessment database");
    }
    const dataGas = (await receipt(await wallet.writeContract({ address: dataAddress, abi: dataStore.abi, functionName: "write", args: [stringToHex(svg)] }))).gasUsed;
    const slotGas = (await receipt(await wallet.writeContract({ address: baselineAddress, abi: baseline.abi, functionName: "store", args: [BigInt(index), svg] }))).gasUsed;
    rows.push({ handle, mbti, svgBytes: Buffer.byteLength(svg), tokenURIBytes: Buffer.byteLength(uri),
      mintGas: String(minted.gasUsed), rawCodeStoreGas: String(dataGas), rawSlotStoreGas: String(slotGas) });
  }
  // Renderer size survey: all 16 personalities, lengths 1..15, mixed cases,
  // digits/underscores; representative evidence, not an exhaustive input proof.
  let maximum = { bytes: 0, handle: "", mbti: "" }, count = 0;
  for (const alphabet of ["ABCDEFGHIJKLMNO", "abcdefghijklmno", "_______________", "Ab_123zXY_456pq7", "012345678901234"]) {
    for (let length = 1; length <= 15; length++) for (const mbti of MBTI_TYPES) {
      const handle = alphabet.slice(0, length), bytes = Buffer.byteLength(renderSignatureSvg(handle, mbti)); count++;
      if (bytes > maximum.bytes) maximum = { bytes, handle, mbti };
      assert.ok(bytes <= 16384, "on-chain SVG byte cap");
    }
  }
  console.log(JSON.stringify({ localOnly: true, realProviderCalls: 0, publicTransactions: 0,
    runtimeBytes: (await client.getCode({ address })).slice(2).length / 2,
    deploymentGas: String(deployed.gasUsed), rows, sizeSurvey: { count, maximum },
    checks: ["exact on-chain SVG recovery", "self-contained tokenURI", "case-sensitive spelling", "Solidity/TypeScript serializer parity", "no website or object storage"] }, null, 2));
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM"); await Promise.race([once(child, "exit"), delay(2_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

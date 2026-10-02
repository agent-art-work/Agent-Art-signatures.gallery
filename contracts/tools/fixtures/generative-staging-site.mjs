import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, hashTypedData } from "viem";
import { stagingAssessmentFixture } from "./generative-staging-assessment.mjs";
import { createStagingMintController } from "../generative-staging-mint.mjs";
import { stagingReviewFixture } from "../../../src/openMint/staging/fixtures/stagingReview.ts";
import { identity, receipt } from "../../../src/openMint/persistence/fixtures/data.ts";
import { GENERATIVE_MINT_ABI as abi, stagingGenerativeMintTypedData } from "../../../src/openMint/generativeAuthorization.ts";
import { GENERATIVE_PROFILES } from "../../../src/openMint/generativeProfiles.ts";

/** Offline-only mint observation driven by the ACTUAL saved signed calldata.
 * Receipts/blocks/artwork are synthetic, not an EVM execution or real X/Grok. */
export async function stagingSiteFixture(cluster, admin, { v2 = false, requestTimeoutMs = 15000 } = {}) {
  const f = await stagingAssessmentFixture(cluster, admin, { admitted: false, v2, requestTimeoutMs });
  const counts = { x: 0, grok: 0, sign: 0 }, calls = [], controls = { mutation: undefined };
  const headers = f.active.headers, q = n => `0x${BigInt(n).toString(16)}`, hash = n => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
  for (const [i, h] of headers.entries()) h.timestamp = q(Math.floor(Date.now() / 1000) - 30 + i * 2);
  let mint, finalized = headers.length - 2;
  const input = { ...f.input, sources: f.eligibilitySources.map((r, i) => ({ ...r, id: f.input.sources[i].id, operatorReference: f.input.sources[i].operatorReference,
    async request(method, params, signal) {
      calls.push({ method, params, source: i }); signal.throwIfAborted(); let result;
      if (method === "eth_getBlockByNumber" && params[0] === "finalized") result = headers[finalized];
      else if (method === "eth_getLogs" && params[0].blockHash) result = mint?.block.hash === params[0].blockHash ? mint.logs : [];
      else if (method === "eth_getTransactionReceipt" && params[0] === mint?.hash) result = { status: "0x1", transactionHash: mint.hash,
        blockHash: mint.block.hash, blockNumber: mint.block.number, transactionIndex: "0x0", logs: mint.logs };
      else if (method === "eth_call" && mint) {
        let name; try { name = decodeFunctionData({ abi, data: params[0].data }).functionName; } catch { /* Governance ABI. */ }
        const value = name === "tokenURI" ? mint.tokenURI : name === "inputs" ? [mint.handle, mint.mbti]
          : name === "provenance" ? [mint.a.assessmentDigest, mint.digest, mint.a.recipient] : name === "ownerOf" ? mint.a.recipient : undefined;
        if (value !== undefined) result = encodeFunctionResult({ abi, functionName: name, result: value });
      }
      if (result === undefined) result = await r.request(method, params, signal);
      return controls.mutation ? controls.mutation(structuredClone(result), method, params, i) : structuredClone(result);
    } })) };
  const candidate = createStagingMintController(input), review = stagingReviewFixture(candidate.scope,
    { operations: ["reuse", "assessment-x", "assessment-grok", "sign", "wallet-submit"] }); candidate.halt(); input.reviewSource = review.source;
  const deps = { sessions: f.sessions,
    signer: { address: f.active.accounts.authorizer.address, async signTypedData(data, signal) { counts.sign++; signal.throwIfAborted(); return f.active.accounts.authorizer.signTypedData(data); } },
    identityResolver: { provenance: "x-api", async resolve(handle, e) { counts.x++; e.dispatch.assertCurrent("x-identity"); await e.recordReceipt(receipt("x-identity", "1")); return { ...identity(handle), username: "ALIce", provenance: "x-api" }; } },
    provider: { provenance: "grok", model: f.input.assessmentPolicy.model, async assess(handle, snapshot, e) {
      counts.grok++; e.dispatch.assertCurrent("grok"); await e.recordReceipt(receipt("grok", "1"));
      return { handle, mbti: "ENFP", model: f.input.assessmentPolicy.model, providerResponseId: "offline-site", sourceUrls: ["https://x.com/ALIce"], xUserId: snapshot.userId };
    } } };
  await f.db.query("UPDATE open_mint.generative_issuance_profiles SET enabled=true");
  return { ...f, input, deps, counts, calls, controls, review,
    include(transaction) {
      const [handle, mbti, a] = decodeFunctionData({ abi, data: transaction.data }).args;
      const profile = GENERATIVE_PROFILES["generative-v1-rc1"], digest = hashTypedData(stagingGenerativeMintTypedData({ chainId: 11155111n,
        verifyingContract: f.config.contract }, a, profile.inputProfile));
      const tokenId = BigInt(a.handleKey), txHash = hash(9001), previous = headers.at(-1);
      const block = { number: q(headers.length), hash: hash(7000 + headers.length), parentHash: previous.hash,
        timestamp: q(BigInt(previous.timestamp) + 1n), transactions: [txHash] }; headers.push(block);
      const common = { address: f.config.contract.toLowerCase(), blockNumber: block.number, blockHash: block.hash,
        transactionHash: txHash, transactionIndex: "0x0", removed: false };
      const args = { ...a, tokenId, renderHandle: handle, mbti, authorizationDigest: digest };
      const logs = [{ ...common, logIndex: "0x0", data: "0x", topics: encodeEventTopics({ abi, eventName: "Transfer",
        args: { tokenId, from: `0x${"0".repeat(40)}`, to: a.recipient } }) },
      { ...common, logIndex: "0x1", topics: encodeEventTopics({ abi, eventName: "GenerativeSignatureMinted", args }),
        data: encodeAbiParameters([{ type: "uint256" }, { type: "string" }, { type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
          [tokenId, handle, mbti, a.assessmentDigest, a.inputDigest, digest]) }];
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><path d="M100 540Q400 150 600 540T980 540" fill="none" stroke="black" stroke-width="12"/></svg>';
      const metadata = { name: `@${handle} × ${mbti}`, description: profile.description, image: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
        attributes: [{ trait_type: "Handle", value: handle }, { trait_type: "MBTI", value: mbti }],
        properties: { renderer: profile.rendererVersion, input_profile: profile.inputProfile, renderer_identity: f.config.generativeRenderer.identity, assessment_digest: a.assessmentDigest } };
      mint = { handle, mbti, a, digest, hash: txHash, block, logs, svg, metadata, tokenURI: `data:application/json;base64,${Buffer.from(JSON.stringify(metadata)).toString("base64")}` };
      return mint;
    },
    finalize() { finalized = headers.length - 1; },
    reorg() { mint = undefined; headers.at(-1).hash = hash(8001); headers.at(-1).transactions = []; },
  };
}

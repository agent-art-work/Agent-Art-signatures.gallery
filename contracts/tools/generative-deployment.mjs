import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import canonicalize from "canonicalize";
import { decodeFunctionResult, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult,
  keccak256, recoverTransactionAddress, serializeTransaction, stringToHex } from "viem";
import { deploymentPlan, loadReleaseArtifacts, PRINCIPALS, RELEASE, ROOT } from "./generative-release.mjs";

// Ethereum clients' published execution genesis, not an operator-supplied alias:
// https://github.com/eth-clients/sepolia/blob/main/README.md
export const SEPOLIA_GENESIS = "0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9";
const ZERO = "0x" + "00".repeat(32), ZERO_ADDRESS = "0x" + "00".repeat(20);
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const sha = value => createHash("sha256").update(canonicalize(value)).digest("hex");
const same = (a, b) => assert.deepEqual(a, b);
const word = value => "0x" + BigInt(value).toString(16).padStart(64, "0");
const quantity = value => {
  assert.ok(typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/.test(value));
  return BigInt(value);
};
const hex = (value, bytes) => {
  assert.ok(typeof value === "string" && new RegExp("^0x[0-9a-f]{" + bytes * 2 + "}$").test(value));
  return value;
};
const address = value => hex(value?.toLowerCase(), 20);
const hash = value => { hex(value, 32); assert.notEqual(value, ZERO); return value; };
const keys = (value, fields) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  same(Object.keys(value).sort(), [...fields].sort());
};
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function shortString(value) {
  const bytes = Buffer.from(value);
  assert.ok(bytes.length < 32);
  return "0x" + bytes.toString("hex").padEnd(62, "0") + bytes.length.toString(16).padStart(2, "0");
}

/** Exact RC-specific immutable substitution. No masked/ignored runtime bytes.
 * Positions are from the locked 0.8.30 build, not unstable compiler AST IDs.
 * A future release must provide a new reviewed mapping and EVM regression. */
export function expectedCollectionRuntime(plan, artifact) {
  same(plan.domain.name, RELEASE.domainName); same(plan.domain.version, RELEASE.domainVersion);
  same(plan.domain.chainId, 11155111); same(plan.domain.verifyingContract, plan.collection.address);
  const groups = [
    [[1692, 3164, 4217, 4414], word(plan.renderer.address)],
    [[1994, 4638, 4865], plan.renderer.identity],
    [[7727], shortString(RELEASE.domainName)], [[7772], shortString(RELEASE.domainVersion)],
    [[11510], word(plan.collection.address)], [[11552], word(11155111)],
    [[11594], keccak256(encodeAbiParameters(
      [{type:"bytes32"},{type:"bytes32"},{type:"bytes32"},{type:"uint256"},{type:"address"}],
      [keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
        keccak256(stringToHex(RELEASE.domainName)),keccak256(stringToHex(RELEASE.domainVersion)),11155111n,plan.collection.address]))],
    [[11675], keccak256(stringToHex(RELEASE.domainName))],
    [[11715], keccak256(stringToHex(RELEASE.domainVersion))],
  ];
  const refs = Object.values(artifact.deployedBytecode.immutableReferences)
    .map(group => group.map(ref => { same(ref.length, 32); return ref.start; }).sort((a,b) => a-b)).sort((a,b) => a[0]-b[0]);
  same(refs, groups.map(([positions]) => positions));
  const bytes = Buffer.from(artifact.deployedBytecode.object.slice(2), "hex");
  for (const [positions, value] of groups) for (const start of positions) {
    hex(value, 32); same(bytes.subarray(start, start + 32), Buffer.alloc(32));
    Buffer.from(value.slice(2), "hex").copy(bytes, start);
  }
  return "0x" + bytes.toString("hex");
}

function header(raw) {
  assert.ok(raw && typeof raw === "object");
  const number = quantity(raw.number), timestamp = quantity(raw.timestamp);
  assert.ok(number <= BigInt(Number.MAX_SAFE_INTEGER) && timestamp <= BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)));
  hash(raw.hash); hex(raw.parentHash, 32);
  assert.ok(Array.isArray(raw.transactions) && raw.transactions.length <= 4096);
  raw.transactions.forEach(hash);
  same(new Set(raw.transactions).size, raw.transactions.length);
  return { number: raw.number, hash: raw.hash, parentHash: raw.parentHash, timestamp: raw.timestamp, transactions: raw.transactions };
}
function log(raw) {
  assert.ok(raw && typeof raw === "object" && raw.removed === false);
  const result = { address: address(raw.address), blockHash: hash(raw.blockHash), blockNumber: raw.blockNumber,
    transactionHash: hash(raw.transactionHash), transactionIndex: raw.transactionIndex, logIndex: raw.logIndex,
    topics: raw.topics, data: raw.data };
  for (const key of ["blockNumber", "transactionIndex", "logIndex"]) assert.ok(quantity(result[key]) <= BigInt(Number.MAX_SAFE_INTEGER));
  assert.ok(Array.isArray(result.topics) && result.topics.length <= 4);
  result.topics.forEach(t => hex(t, 32));
  assert.ok(typeof result.data === "string" && /^0x(?:[0-9a-f]{2})*$/.test(result.data) && result.data.length <= 4098);
  return result;
}

/** Reconstruct the signed type-2 CREATE transaction, not just RPC "from".
 * This initial deployment verifier intentionally supports empty-access-list
 * EIP-1559 deployments only; arbitrary transaction formats are not inferred. */
export async function verifyCreationTransaction(raw, receipt, block, expected, plan) {
  same(raw?.type, "0x2"); same(raw.chainId, "0xaa36a7"); same(raw.to, null);
  same(raw.value, "0x0"); same(raw.accessList, []);
  same(raw.hash, expected.transactionHash); same(raw.blockHash, block.hash);
  same(raw.blockNumber, block.number); same(raw.transactionIndex, receipt.transactionIndex);
  same(quantity(raw.nonce), BigInt(expected.nonce));
  same(address(raw.from), plan.principals.deployer.address);
  assert.ok(typeof raw.input === "string" && /^0x(?:[0-9a-f]{2})+$/.test(raw.input) && raw.input.length <= 98306);
  same(keccak256(raw.input), expected.initcodeHash);
  const nonce = quantity(raw.nonce); assert.ok(nonce <= BigInt(Number.MAX_SAFE_INTEGER));
  const gas = quantity(raw.gas), maxFeePerGas = quantity(raw.maxFeePerGas), maxPriorityFeePerGas = quantity(raw.maxPriorityFeePerGas);
  assert.ok(gas > 0n && maxFeePerGas >= maxPriorityFeePerGas);
  hex(raw.r, 32); hex(raw.s, 32);
  assert.ok(BigInt(raw.r) > 0n && BigInt(raw.s) > 0n && BigInt(raw.s) <= HALF_N);
  const parity = quantity(raw.yParity ?? raw.v); assert.ok(parity === 0n || parity === 1n);
  if (raw.v !== undefined) same(quantity(raw.v), parity);
  const serialized = serializeTransaction({ type: "eip1559", chainId: 11155111, nonce: Number(nonce), gas,
    maxFeePerGas, maxPriorityFeePerGas, value: 0n, data: raw.input, accessList: [] },
  { r: raw.r, s: raw.s, yParity: Number(parity) });
  same(keccak256(serialized), expected.transactionHash);
  same((await recoverTransactionAddress({ serializedTransaction: serialized })).toLowerCase(), plan.principals.deployer.address);
  same(receipt.status, "0x1"); same(receipt.type, "0x2"); same(receipt.to, null);
  same(receipt.transactionHash, expected.transactionHash); same(receipt.blockHash, block.hash); same(receipt.blockNumber, block.number);
  same(address(receipt.from), plan.principals.deployer.address); same(address(receipt.contractAddress), expected.address);
  const index = quantity(receipt.transactionIndex);
  assert.ok(index < BigInt(block.transactions.length)); same(block.transactions[Number(index)], expected.transactionHash);
  assert.ok(quantity(receipt.gasUsed) > 0n && quantity(receipt.gasUsed) <= gas);
  assert.ok(Array.isArray(receipt.logs) && receipt.logs.length <= 16);
  const logs = receipt.logs.map(log);
  for (const entry of logs) {
    same(entry.blockHash, block.hash); same(entry.blockNumber, block.number);
    same(entry.transactionHash, expected.transactionHash); same(entry.transactionIndex, receipt.transactionIndex);
  }
  for (let i=1;i<logs.length;i++) assert.ok(quantity(logs[i].logIndex) > quantity(logs[i-1].logIndex));
  return { hash: expected.transactionHash, blockNumber: block.number, blockHash: block.hash, transactionIndex: receipt.transactionIndex, logs };
}
function constructorEvents(plan, abi) {
  const role = name => name === "DEFAULT_ADMIN_ROLE" ? ZERO : keccak256(stringToHex(name));
  const event = (eventName, args, data = "0x") => ({ address: plan.collection.address,
    topics: encodeEventTopics({ abi, eventName, args }).map(v => v.toLowerCase()), data });
  return [
    ...[["DEFAULT_ADMIN_ROLE","delayedAdmin"], ["AUTHORIZER_MANAGER_ROLE","authorizerManager"], ["PAUSER_ROLE","pauser"],
      ["NONCE_REVOKER_ROLE","nonceRevoker"]].map(([name, principal]) =>
      event("RoleGranted", { role: role(name), account: plan.principals[principal].address, sender: plan.principals.deployer.address })),
    event("TrustedAuthorizerChanged", { previousAuthorizer: ZERO_ADDRESS, newAuthorizer: plan.principals.authorizer.address }),
    event("Paused", {}, encodeAbiParameters([{type:"address"}], [plan.principals.deployer.address])),
  ];
}

// Stateless parsers shared with the separate active-state observer. Exporting
// these does not relax this observer's pristine/paused-only history policy.
export { header as observationHeader, log as observationLog, constructorEvents };

const observations = new WeakMap();
/** A report is descriptive and copyable, never a reusable startup capability. */
export function readDeploymentObservation(witness, { planSha256, now = Date.now() }) {
  const report = witness && observations.get(witness);
  if (!report || report.planSha256 !== planSha256 || !Number.isSafeInteger(now) || now < report.observedAt || now >= report.validUntil)
    throw new Error("Deployment observation is absent, stale or belongs to another plan.");
  return report;
}

/** Bounded, injected, read-only observation. No environment, fetch, credentials,
 * signing, deployment, migration, retries or public-startup authority.
 * Provider/owner references are declarations, not cryptographic independence.
 * Requires a pristine paused deployment: no contract events after construction.
 */
export function createDeploymentObserver({ config, transactions, sources, policy, root = ROOT, now = Date.now }) {
  const plan = freeze(deploymentPlan(config, root)), builds = loadReleaseArtifacts(root);
  same(plan.declaredGenesisHash, SEPOLIA_GENESIS);
  keys(transactions, ["renderer", "collection"]); hash(transactions.renderer); hash(transactions.collection);
  assert.notEqual(transactions.renderer, transactions.collection);
  const txs = { ...transactions };
  keys(policy, ["timeoutMs", "maxHeadAgeMs", "maxFinalizedAgeMs", "maxFutureSkewMs", "validityMs", "maxDeploymentSpan"]);
  const p = { ...policy };
  for (const key of Object.keys(p)) assert.ok(Number.isSafeInteger(p[key]) && (key === "maxFutureSkewMs" ? p[key] >= 0 : p[key] > 0));
  assert.ok(p.timeoutMs <= 30000 && p.maxHeadAgeMs <= 300000 && p.maxFinalizedAgeMs <= 3600000
    && p.maxFutureSkewMs <= 30000 && p.validityMs <= 30000 && p.maxDeploymentSpan <= 512);
  assert.ok(Array.isArray(sources) && sources.length === 2 && sources[0] !== sources[1] && sources[0].request !== sources[1].request);
  for (const source of sources) {
    keys(source, ["id", "operatorReference", "request"]);
    for (const key of ["id", "operatorReference"]) assert.match(source[key], /^[a-z0-9][a-z0-9._/-]{2,95}$/);
    assert.equal(typeof source.request, "function");
  }
  assert.notEqual(sources[0].id, sources[1].id); assert.notEqual(sources[0].operatorReference, sources[1].operatorReference);
  const rpcs = sources.map(s => ({ id: s.id, operatorReference: s.operatorReference, request: s.request.bind(s) }));
  const collection = builds.GenerativeSignaturesV1RC1, renderer = builds.SignatureRendererV1RC1;
  const runtime = expectedCollectionRuntime(plan, collection), expectedEvents = constructorEvents(plan, collection.abi);
  return Object.freeze({ plan, async observe(signal = new AbortController().signal) {
    const controller = new AbortController(), started = performance.now(), startWall = now();
    let timer, abort;
    const check = () => {
      const wall = now();
      assert.ok(Number.isSafeInteger(wall) && wall >= startWall);
      assert.ok(!signal.aborted && !controller.signal.aborted && performance.now() - started < p.timeoutMs && wall - startWall < p.timeoutMs);
    };
    const stop = new Promise((_, reject) => {
      abort = () => { controller.abort(); reject(new Error("Deployment observation cancelled.")); };
      signal.addEventListener("abort", abort, { once:true });
      timer = setTimeout(abort, p.timeoutMs);
    });
    try {
      check();
      const observeSource = async rpc => {
        let count = 0;
        const call = async (method, params) => {
          check(); assert.ok(++count <= 256);
          const result = await rpc.request(method, params, controller.signal); check();
          // Transport must bound streaming bytes too; this caps decoded evidence.
          const json = JSON.stringify(result); assert.ok(typeof json === "string" && Buffer.byteLength(json) <= 1048576);
          return result;
        };
        same(await call("eth_chainId", []), "0xaa36a7");
        const getHeader = async tag => header(await call("eth_getBlockByNumber", [tag, false]));
        const genesis = await getHeader("0x0"); same(genesis.number, "0x0"); same(genesis.hash, SEPOLIA_GENESIS);
        const [finalized, latest] = await Promise.all([getHeader("finalized"), getHeader("latest")]);
        assert.ok(quantity(finalized.number) <= quantity(latest.number) && quantity(finalized.timestamp) <= quantity(latest.timestamp));
        for (const [head, age] of [[latest,p.maxHeadAgeMs],[finalized,p.maxFinalizedAgeMs]]) {
          const ms = Number(quantity(head.timestamp)) * 1000; assert.ok(ms <= startWall + p.maxFutureSkewMs && startWall - ms <= age);
        }
        const deployment = {};
        for (const name of ["renderer", "collection"]) {
          const [raw, receipt] = await Promise.all([call("eth_getTransactionByHash", [txs[name]]), call("eth_getTransactionReceipt", [txs[name]])]);
          assert.ok(receipt && typeof receipt === "object");
          const block = await getHeader(receipt.blockNumber);
          assert.ok(quantity(block.number) > 0n && quantity(block.number) <= quantity(finalized.number)
            && quantity(latest.number) - quantity(block.number) <= BigInt(p.maxDeploymentSpan));
          deployment[name] = await verifyCreationTransaction(raw, receipt, block, { ...plan[name], transactionHash: txs[name] }, plan);
        }
        assert.ok(quantity(deployment.renderer.blockNumber) < quantity(deployment.collection.blockNumber)
          || (deployment.renderer.blockNumber === deployment.collection.blockNumber &&
            quantity(deployment.renderer.transactionIndex) < quantity(deployment.collection.transactionIndex)));
        same(deployment.renderer.logs, []);
        same(deployment.collection.logs.map(({ address, topics, data }) => ({ address, topics, data })), expectedEvents);
        // Both RPCs must supply ALL address logs, not just the expected role topics.
        const history = await call("eth_getLogs", [{ address: plan.collection.address,
          fromBlock: deployment.collection.blockNumber, toBlock: latest.number }]);
        assert.ok(Array.isArray(history) && history.length <= 2048);
        same(history.map(log), deployment.collection.logs);
        const readState = async block => {
          const pinned = { blockHash:block.hash, requireCanonical:true };
          const read = async (functionName, args = [], target = plan.collection.address, abi = collection.abi) => {
            const result = await call("eth_call", [{to:target, data:encodeFunctionData({abi,functionName,args}), gas:"0x1e8480"}, pinned]);
            assert.ok(typeof result === "string" && /^0x(?:[0-9a-f]{2})+$/.test(result) && result.length <= 32770);
            const decoded = decodeFunctionResult({abi,functionName,data:result});
            same(encodeFunctionResult({abi,functionName,result:decoded}), result);
            return decoded;
          };
          same(await call("eth_getCode", [plan.renderer.address,pinned]), renderer.deployedBytecode.object);
          same(await call("eth_getCode", [plan.collection.address,pinned]), runtime);
          const scalar = [
            ["VERSION",RELEASE.collection],["INPUT_PROFILE",RELEASE.inputProfile],["renderer",plan.renderer.address],
            ["rendererIdentity",plan.renderer.identity],["trustedAuthorizer",plan.principals.authorizer.address],
            ["paused",true],["defaultAdmin",plan.principals.delayedAdmin.address],["defaultAdminDelay",BigInt(plan.adminDelay)],
            ["pendingDefaultAdmin",[ZERO_ADDRESS,0n]],["pendingDefaultAdminDelay",[0n,0n]],
            ["eip712Domain",["0x0f",RELEASE.domainName,RELEASE.domainVersion,11155111n,plan.collection.address,ZERO,[]]],
          ];
          const lower = v => typeof v === "string" && /^0x/.test(v) ? v.toLowerCase() :
            typeof v === "number" ? BigInt(v) : Array.isArray(v) ? v.map(lower) : v;
          for (const [name, expected] of scalar) same(lower(await read(name)), expected);
          same(await read("VERSION",[],plan.renderer.address,renderer.abi), RELEASE.renderer);
          const roles = [["DEFAULT_ADMIN_ROLE","delayedAdmin"],["AUTHORIZER_MANAGER_ROLE","authorizerManager"],
            ["PAUSER_ROLE","pauser"],["NONCE_REVOKER_ROLE","nonceRevoker"]];
          for (const [roleName, principal] of roles) {
            const role = roleName === "DEFAULT_ADMIN_ROLE" ? ZERO : keccak256(stringToHex(roleName));
            same(await read(roleName), role); same(await read("getRoleAdmin",[role]), ZERO);
            for (const name of PRINCIPALS) same(await read("hasRole",[role,plan.principals[name].address]), name === principal);
          }
          same(await call("eth_getCode", [plan.principals.deployer.address,pinned]), "0x");
          same(await call("eth_getCode", [plan.principals.authorizer.address,pinned]), "0x");
        };
        await readState(finalized);
        if (latest.hash !== finalized.hash) await readState(latest);
        // Recheck canonical pins, receipts/history and stable tags after reads.
        for (const head of [genesis,finalized,latest]) same(await getHeader(head.number), head);
        for (const name of ["renderer","collection"]) {
          const receipt = await call("eth_getTransactionReceipt", [txs[name]]);
          same(receipt?.blockHash, deployment[name].blockHash); same(receipt?.status,"0x1");
          same((await getHeader(deployment[name].blockNumber)).hash, deployment[name].blockHash);
        }
        same(await call("eth_getLogs", [{address:plan.collection.address,fromBlock:deployment.collection.blockNumber,toBlock:latest.number}]), history);
        same(await getHeader("finalized"), finalized); same(await getHeader("latest"), latest);
        same(await call("eth_chainId", []), "0xaa36a7");
        return {genesis,finalized,latest,deployment,collectionRuntimeCodeHash:keccak256(runtime),requestCount:count};
      };
      const results = await Promise.race([Promise.all(rpcs.map(observeSource)), stop]); check();
      same(results[0],results[1]);
      const observedAt = now(), validUntil = Math.min(observedAt + p.validityMs,
        Number(quantity(results[0].latest.timestamp))*1000 + p.maxHeadAgeMs,
        Number(quantity(results[0].finalized.timestamp))*1000 + p.maxFinalizedAgeMs);
      assert.ok(validUntil > observedAt);
      const body = { schema:"sg-generative-deployment-observation-v1", status:"observed-paused-not-admitted",
        planSha256:plan.planSha256,releaseLockSha256:plan.releaseLockSha256,chainId:11155111,origin:plan.origin,
        ...results[0], observedAt,validUntil,sources:rpcs.map(({id,operatorReference})=>({id,operatorReference})),
        sourceIndependence:"operator-declared-not-proven", custodyVerified:false, readLimitsValidated:false,
        publicBroadcastAllowed:false,runtimeAdmissionAllowed:false,activationAllowed:false };
      const report = freeze({...body,observationSha256:sha(body)}), witness = Object.freeze({});
      observations.set(witness,report);
      return witness;
    } catch {
      // Never echo provider URLs, request bodies or remote error messages.
      throw new Error("Deployment verification failed; preserve the paused state and investigate.");
    } finally { controller.abort(); clearTimeout(timer); signal.removeEventListener("abort",abort); }
  }});
}

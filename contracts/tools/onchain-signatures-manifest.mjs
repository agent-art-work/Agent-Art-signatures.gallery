import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import canonicalize from "canonicalize";
import { encodeDeployData, getContractAddress, keccak256 } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

export const COLLECTION_JSON = '{"name":"Signatures Gallery","description":"Fully on-chain signature artwork. One token per canonical X handle."}';
export const COLLECTION_URI = `data:application/json;base64,${Buffer.from(COLLECTION_JSON).toString("base64")}`;
export const MANIFEST_VERSION = "sg-onchain-signatures-deployment-v1";
export const ABI_VERSION = "sg-onchain-signatures-abi-v1";
export const COLLECTION_PROFILE = "sg-onchain-collection-data-v1";
export const SCHEMA = JSON.parse(readFileSync(new URL("./onchain-signatures-manifest.schema.json", import.meta.url), "utf8"));
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const ZERO_HASH = `0x${"0".repeat(64)}`;
const IDENTITIES = ["deployer", "delayedAdmin", "authorizerManager", "pauser", "nonceRevoker", "authorizer"];
const sha = bytes => `0x${createHash("sha256").update(bytes).digest("hex")}`;
const same = (a, b, name) => requireValue(a === b, `${name} mismatch`);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
function fields(value, expected, name) {
  requireValue(object(value) && Object.keys(value).sort().join(",") === [...expected].sort().join(","), `${name} fields`);
}
function schema(value, rule, path = "manifest") {
  if (rule.$ref) return schema(value, SCHEMA.$defs[rule.$ref.split("/").at(-1)], path);
  if (rule.const !== undefined) same(value, rule.const, path);
  if (rule.enum) requireValue(rule.enum.includes(value), `${path} enum`);
  if (rule.type === "object") {
    fields(value, rule.required, path);
    for (const [key, member] of Object.entries(rule.properties)) schema(value[key], member, `${path}.${key}`);
  } else if (rule.type === "string") {
    requireValue(typeof value === "string", `${path} string`);
    requireValue(value.length >= (rule.minLength ?? 0) && value.length <= (rule.maxLength ?? 4096), `${path} length`);
    if (rule.pattern) requireValue(new RegExp(rule.pattern, "u").test(value), `${path} format`);
  } else if (rule.type === "array") {
    requireValue(Array.isArray(value) && value.length >= rule.minItems && value.length <= rule.maxItems, `${path} array`);
    if (rule.uniqueItems) requireValue(new Set(value).size === value.length, `${path} duplicates`);
    value.forEach((member, i) => schema(member, rule.items, `${path}[${i}]`));
  }
}
function quantity(value, name) { requireValue(typeof value === "string" && UINT.test(value) && BigInt(value) < 2n ** 256n, `${name} quantity`); }
function hash(value, name) { requireValue(typeof value === "string" && HASH.test(value) && value !== ZERO_HASH, `${name} hash`); }
function address(value, name) { requireValue(typeof value === "string" && ADDRESS.test(value) && BigInt(value) !== 0n, `${name} address`); }
function bytecode(value, name) { requireValue(typeof value === "string" && /^0x(?:[0-9a-f]{2})+$/.test(value) && value.length <= 262146, `${name} bytecode`); }

/** Publicly known throwaway identities only; no key material is accepted from a manifest. */
const TEST_ADDRESSES = new Set([
  ...Array.from({ length: 20 }, (_, addressIndex) => mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex }).address.toLowerCase()),
  ...Array.from({ length: 16 }, (_, index) => privateKeyToAccount(`0x${BigInt(index + 1).toString(16).padStart(64, "0")}`).address.toLowerCase()),
]);

/** Validates configuration only. Does not fetch or return credential-bearing URLs. */
export function validateRpcConfiguration(rpcUrl, environment) {
  let url; try { url = new URL(rpcUrl); } catch { throw new Error("RPC configuration invalid"); }
  requireValue(!url.username && !url.password && !url.hash, "RPC credentials/fragments forbidden");
  if (environment === "local-anvil") {
    requireValue(["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "local RPC must be loopback");
  } else {
    requireValue(environment === "public-testnet-draft" && url.protocol === "https:" && !isIP(url.hostname.replace(/^\[|\]$/g, ""))
      && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(url.hostname)
      && !/(?:^|\.)(?:localhost|local|internal|onion|test|invalid)$/.test(url.hostname), "public RPC must not be a dev endpoint");
  }
  return true;
}

export function buildIdentity(artifact, sourceBytes) {
  requireValue(object(artifact) && Array.isArray(artifact.abi) && object(artifact.metadata), "OnchainSignatures artifact required");
  same(canonicalize(artifact.metadata.settings?.compilationTarget), canonicalize({ "src/OnchainSignatures.sol": "OnchainSignatures" }), "artifact target");
  bytecode(artifact.bytecode?.object, "creation"); bytecode(artifact.deployedBytecode?.object, "runtime template");
  same(artifact.metadata.sources?.["src/OnchainSignatures.sol"]?.keccak256, keccak256(sourceBytes), "compiled source");
  const constructor = artifact.abi.find(item => item.type === "constructor");
  same(constructor?.inputs?.map(item => item.type).join(","), "string,string,uint48,address,address,address,address,address", "OnchainSignatures constructor ABI");
  same(constructor.stateMutability, "nonpayable", "OnchainSignatures constructor mutability");
  requireValue(artifact.abi.some(item => item.name === "mint" && item.stateMutability === "nonpayable"), "nonpayable mint ABI required");
  for (const legacy of ["collectionMetadataSha256", "collectionURIHash", "currentAuthorizerEpoch", "AUTHORIZATION_REVOKER_ROLE"]) {
    requireValue(!artifact.abi.some(item => item.name === legacy), "legacy ABI forbidden");
  }
  const mint = artifact.abi.find(item => item.type === "function" && item.name === "mint");
  same(mint?.inputs?.map(item => item.type).join(","), "string,tuple,tuple,bytes", "on-chain mint ABI");
  same(mint?.inputs?.[2]?.components?.map(item => `${item.type} ${item.name}`).join(","),
    "string renderHandle,string mbti,string svg", "embedded artwork ABI");
  requireValue(artifact.abi.some(item => item.name === "svg" && item.stateMutability === "view"), "chain SVG reader required");
  requireValue((artifact.deployedBytecode.object.length - 2) / 2 <= 24576, "EIP-170 runtime size");
  return { compilerVersion: artifact.metadata.compiler.version, sourceSha256: sha(sourceBytes), metadataSha256: sha(canonicalize(artifact.metadata)),
    settingsSha256: sha(canonicalize(artifact.metadata.settings)), abiSha256: sha(canonicalize(artifact.abi)),
    creationCodeHash: keccak256(artifact.bytecode.object), runtimeTemplateHash: keccak256(artifact.deployedBytecode.object) };
}

export function deploymentInitcode(artifact, constructor) {
  return encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object,
    args: [constructor.name, constructor.symbol, BigInt(constructor.adminDelay), constructor.delayedAdmin,
      constructor.authorizerManager, constructor.pauser, constructor.nonceRevoker, constructor.authorizer] });
}

function matchRuntime(runtime, artifact) {
  bytecode(runtime, "observed runtime");
  const actual = Buffer.from(runtime.slice(2), "hex"), template = Buffer.from(artifact.deployedBytecode.object.slice(2), "hex");
  same(actual.length, template.length, "runtime length");
  // OpenZeppelin EIP712 embeds chain/address/name caches as Solidity immutables.
  // Match all executable bytes; separately verify the complete ERC-5267 domain.
  const references = Object.values(artifact.deployedBytecode.immutableReferences ?? {}).flat();
  requireValue(references.length <= 64, "immutable reference count");
  for (const { start, length } of references) {
    requireValue(Number.isSafeInteger(start) && start >= 0 && length === 32 && start + length <= actual.length, "immutable reference range");
    actual.fill(0, start, start + length); template.fill(0, start, start + length);
  }
  requireValue(actual.equals(template), "runtime does not match compiled OnchainSignatures");
}

/** Offline consistency check against separately supplied, pinned observations.
 * Observations are inputs, not independently fetched or attested by this tool.
 * This result never grants signing, deployment, publication or runtime authority.
 */
export async function validateOnchainSignaturesManifest(manifest, { artifact, sourceBytes, collectionBytes, expected, observed, rpcUrl, allowlistedTestnetChainIds = [] }) {
  schema(manifest, SCHEMA);
  const c = manifest.constructor, d = manifest.deployment, chain = manifest.chain;
  requireValue(Buffer.byteLength(c.name) <= 128 && Buffer.byteLength(c.symbol) <= 16, "collection identity byte bounds");
  quantity(chain.chainId, "chain ID"); hash(chain.genesisHash, "genesis");
  requireValue(chain.chainId !== "1" && chain.chainId !== "0", "mainnet/zero chain forbidden");
  if (manifest.environment === "local-anvil") same(chain.chainId, "31337", "local chain");
  else requireValue(chain.chainId !== "31337" && chain.chainId !== "1337" && allowlistedTestnetChainIds.includes(chain.chainId), "testnet is not explicitly allowlisted");
  validateRpcConfiguration(rpcUrl, manifest.environment);
  fields(expected, ["chainId", "genesisHash", "contractAddress", "trustedAuthorizer", "initcodeHash", "runtimeCodeHash"], "expected identity");
  for (const [actual, pinned, name] of [[chain.chainId, expected.chainId, "chain"], [chain.genesisHash, expected.genesisHash, "genesis"],
    [d.address, expected.contractAddress, "contract"], [c.authorizer, expected.trustedAuthorizer, "signer"],
    [d.initcodeHash, expected.initcodeHash, "initcode"], [d.runtimeCodeHash, expected.runtimeCodeHash, "runtime"]]) same(actual, pinned, `pinned ${name}`);
  quantity(c.adminDelay, "admin delay"); requireValue(BigInt(c.adminDelay) > 0n && BigInt(c.adminDelay) < 2n ** 48n, "admin delay out of bounds");
  const identities = IDENTITIES.map(key => key === "deployer" ? d.deployer : c[key]);
  identities.forEach(value => address(value, "role")); requireValue(new Set(identities).size === 6, "role addresses must be distinct");
  requireValue(new Set(Object.values(manifest.roleOwners)).size === 6, "role owner references must be distinct");
  if (manifest.environment !== "local-anvil") {
    requireValue(identities.every(value => !TEST_ADDRESSES.has(value) && BigInt(value) > 65535n), "public configuration rejects known test identities");
  }
  for (const [key, value] of Object.entries(buildIdentity(artifact, sourceBytes))) same(manifest.build[key], value, `build ${key}`);
  requireValue(Buffer.isBuffer(collectionBytes) && collectionBytes.length > 0 && collectionBytes.length <= 262144, "small collection bytes required");
  const collectionText = collectionBytes.toString("utf8");
  requireValue(Buffer.from(collectionText).equals(collectionBytes), "collection UTF-8 required");
  const collection = JSON.parse(collectionText);
  same(collectionText, COLLECTION_JSON, "fixed on-chain collection JSON");
  same(collection.name, c.name, "collection name");
  same(manifest.collection.bytesSha256, sha(collectionBytes), "collection bytes");

  same(d.initcodeHash, keccak256(deploymentInitcode(artifact, c)), "constructor initcode");
  address(d.address, "contract"); quantity(d.nonce, "deployment nonce"); quantity(d.blockNumber, "deployment block");
  for (const name of ["transactionHash", "blockHash", "initcodeHash", "runtimeCodeHash"]) hash(d[name], name);
  same(getContractAddress({ from: d.deployer, nonce: BigInt(d.nonce) }).toLowerCase(), d.address, "CREATE address");
  same(manifest.domain.chainId, chain.chainId, "domain chain"); same(manifest.domain.verifyingContract, d.address, "domain contract");
  fields(observed, ["chainId", "genesisHash", "blockNumber", "blockHash", "contractAddress", "runtimeCode", "receipt", "domain", "name", "symbol", "contractURI", "defaultAdmin", "defaultAdminDelay", "trustedAuthorizer", "paused", "roleMatrix"], "observations");
  same(observed.chainId, chain.chainId, "observed chain"); same(observed.genesisHash, chain.genesisHash, "observed genesis");
  same(observed.contractAddress, d.address, "observed contract"); quantity(observed.blockNumber, "observation block"); hash(observed.blockHash, "observation block");
  requireValue(BigInt(observed.blockNumber) >= BigInt(d.blockNumber), "observation predates deployment");
  if (observed.blockNumber === d.blockNumber) same(observed.blockHash, d.blockHash, "deployment observation block hash");
  matchRuntime(observed.runtimeCode, artifact); same(keccak256(observed.runtimeCode), d.runtimeCodeHash, "runtime code hash");
  fields(observed.receipt, ["status", "transactionHash", "blockNumber", "blockHash", "from", "to", "nonce", "contractAddress", "transactionInput"], "deployment receipt");
  same(observed.receipt.status, "success", "deployment status"); same(observed.receipt.to, null, "CREATE recipient");
  for (const key of ["transactionHash", "blockNumber", "blockHash", "nonce"]) same(observed.receipt[key], d[key], `receipt ${key}`);
  same(observed.receipt.from, d.deployer, "deployment sender"); same(observed.receipt.contractAddress, d.address, "receipt contract");
  same(observed.receipt.transactionInput, deploymentInitcode(artifact, c), "deployment transaction bytes");
  fields(observed.domain, ["fields", "name", "version", "chainId", "verifyingContract", "salt", "extensions"], "observed domain");
  for (const key of ["name", "version", "chainId", "verifyingContract"]) same(observed.domain[key], manifest.domain[key], `observed domain ${key}`);
  same(observed.domain.fields, "0x0f", "domain fields"); same(observed.domain.salt, ZERO_HASH, "domain salt");
  requireValue(Array.isArray(observed.domain.extensions) && observed.domain.extensions.length === 0, "domain extensions forbidden");
  for (const [key, expectedValue] of Object.entries({ name: c.name, symbol: c.symbol, contractURI: COLLECTION_URI, defaultAdmin: c.delayedAdmin,
    defaultAdminDelay: c.adminDelay, trustedAuthorizer: c.authorizer, paused: false })) same(observed[key], expectedValue, `observed ${key}`);
  requireValue(Array.isArray(observed.roleMatrix) && observed.roleMatrix.length === 24, "role matrix size");
  observed.roleMatrix.forEach((value, i) => same(value, i % 6 === Math.floor(i / 6) + 1, "observed role membership"));
  return { manifestVersion: MANIFEST_VERSION, manifestSha256: sha(canonicalize(manifest)), offlineConsistent: true,
    observationsIndependentlyVerified: false, publicBroadcastAllowed: false, runtimeAdmissionAllowed: false };
}

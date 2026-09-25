import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import canonicalize from "canonicalize";
import { operatingPlan } from "./generative-operating-plan.mjs";
import { readFileBounded } from "./generative-staging-bootstrap.mjs";
import { openMintSupportUrl } from "../../src/openMint/supportUrl.ts";

const deny = () => { throw Error("Staging installation unavailable."); };
const exact = (v, names) => {
  assert.ok(v && Object.getPrototypeOf(v) === Object.prototype);
  assert.deepEqual(Reflect.ownKeys(v).sort(), [...names].sort());
  for (const name of names) assert.ok(Object.getOwnPropertyDescriptor(v, name)?.value !== undefined || v[name] === null);
};
const hash = value => typeof value === "string" && /^(?!0{64}$)[0-9a-f]{64}$/.test(value);
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const absolute = value => typeof value === "string" && value.length < 4096 && isAbsolute(value) && resolve(value) === value && !value.includes("\0");
const pinned = (v, max) => {
  exact(v, ["path", "sha256", "maxBytes"]);
  assert.ok(absolute(v.path) && hash(v.sha256) && Number.isSafeInteger(v.maxBytes) && v.maxBytes > 0 && v.maxBytes <= max);
};
const parsePinned = (v, max) => {
  pinned(v, max);
  const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileBounded(v.path, v.maxBytes, v.sha256)).replace(/\n$/, "");
  const data = JSON.parse(raw);
  assert.equal(canonicalize(data), raw);
  return data;
};
const reviewer = v => {
  exact(v, ["directory", "fileName", "ownerUid", "publicKeyPem", "publicKeySpkiSha256", "revisionSha256"]);
  assert.ok(absolute(v.directory) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.json$/.test(v.fileName)
    && Number.isSafeInteger(v.ownerUid) && v.ownerUid >= 0 && v.ownerUid <= 0xffffffff
    && typeof v.publicKeyPem === "string" && v.publicKeyPem.length <= 1024
    && hash(v.publicKeySpkiSha256) && hash(v.revisionSha256));
  const key = createPublicKey(v.publicKeyPem);
  assert.equal(key.asymmetricKeyType, "ed25519");
  assert.equal(createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex"), v.publicKeySpkiSha256);
};
const freeze = value => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};

/** No secrets, network, writer or review signing. The expected SHA-256 comes
 * from the trusted launcher; neither this JSON nor the package self-pins it. */
export function loadStagingInstallation(path, expectedSha256, root) {
  try {
    assert.ok(absolute(path) && hash(expectedSha256));
    const config = parsePinned({ path, sha256: expectedSha256, maxBytes: 65536 }, 65536);
    exact(config, ["schema", "installationId", "origin", "chainId", "deploymentId", "namespaceId", "operating", "evidence", "connections", "secrets", "reviews", "listener", "supportUrl"]);
    assert.equal(config.schema, "sg-staging-installation-v1");
    assert.ok(uuid(config.installationId) && uuid(config.deploymentId) && uuid(config.namespaceId));
    assert.equal(config.origin, "https://staging.signatures.gallery"); assert.equal(config.chainId, 11155111);
    pinned(config.operating, 32768);
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileBounded(config.operating.path, config.operating.maxBytes, config.operating.sha256));
    const op = operatingPlan(raw, root), s = op.operatingPlan.settings;
    assert.equal(s.schema, "sg-sepolia-operating-settings-v2");
    assert.equal(s.origin, config.origin); assert.equal(s.deploymentId, config.deploymentId);
    exact(config.evidence, ["transactions", "transitions", "historyLimits", "assessmentPolicy", "databaseReview"]);
    const evidence = Object.fromEntries(Object.entries(config.evidence).map(([key, value]) => [key, parsePinned(value, key === "transactions" || key === "transitions" ? 1_000_000 : 65536)]));
    assert.equal(evidence.databaseReview.namespaceId, config.namespaceId);
    assert.equal(evidence.databaseReview.deploymentId, config.deploymentId);
    assert.equal(evidence.databaseReview.version, "sg-generative-runtime-db-review-v2");
    exact(config.connections, ["database", "rpcs"]);
    exact(config.connections.database, ["resourceReference", "host", "port", "database", "browserRole", "tlsRoot"]);
    const db = config.connections.database;
    assert.equal(db.resourceReference, s.database.resourceReference);
    assert.equal(db.database, evidence.databaseReview.database);
    assert.equal(db.browserRole, s.database.roles.browser.name);
    assert.ok(typeof db.host === "string" && /^[A-Za-z0-9.-]{1,253}$/.test(db.host) && db.host.includes(".")
      && !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(db.host));
    assert.ok(Number.isSafeInteger(db.port) && db.port > 0 && db.port <= 65535);
    pinned(db.tlsRoot, 65536);
    assert.ok(Array.isArray(config.connections.rpcs) && config.connections.rpcs.length === 2);
    for (let i = 0; i < 2; i++) {
      const entry = config.connections.rpcs[i], declared = s.rpc.sources[i];
      exact(entry, ["id", "operatorReference", "endpointSecretReference"]);
      assert.equal(entry.id, declared.id); assert.equal(entry.operatorReference, declared.operatorReference);
      assert.equal(entry.endpointSecretReference, declared.endpointSecretReference);
    }
    assert.ok(config.connections.rpcs[0].operatorReference !== config.connections.rpcs[1].operatorReference);
    exact(config.reviews, ["operation", "readiness", "recovery", "backup"]);
    for (const item of Object.values(config.reviews)) reviewer(item);
    assert.equal(new Set(Object.values(config.reviews).map(item => item.publicKeySpkiSha256)).size, 4);
    exact(config.listener, ["publicPort", "healthPort", "attachmentWaitMs"]);
    for (const port of [config.listener.publicPort, config.listener.healthPort]) assert.ok(Number.isSafeInteger(port) && port >= 1 && port <= 65535);
    assert.notEqual(config.listener.publicPort, config.listener.healthPort);
    assert.ok(Number.isSafeInteger(config.listener.attachmentWaitMs) && config.listener.attachmentWaitMs >= 1000 && config.listener.attachmentWaitMs <= 900000);
    assert.ok(config.supportUrl === null || (typeof config.supportUrl === "string" && openMintSupportUrl(config.supportUrl) === config.supportUrl));
    assert.ok(Array.isArray(config.secrets) && config.secrets.length <= 10);
    const permitted = new Set([s.database.roles.browser.connectionSecretReference, s.database.roles.migrator.connectionSecretReference,
      s.database.roles.inspector.connectionSecretReference, s.database.roles.recovery.connectionSecretReference,
      ...s.rpc.sources.map(v => v.endpointSecretReference), s.assessment.xCredentialReference,
      s.assessment.xaiCredentialReference, s.custody.authorizer.signerSecretReference]);
    const seen = new Set();
    for (const item of config.secrets) {
      exact(item, ["reference", "path", "ownerUid"]);
      assert.ok(permitted.has(item.reference) && !seen.has(item.reference) && absolute(item.path)
        && Number.isSafeInteger(item.ownerUid) && item.ownerUid >= 0 && item.ownerUid <= 0xffffffff);
      seen.add(item.reference);
    }
    // The passive checker reports only identities, never operator material.
    return Object.freeze({ config: freeze(config), operating: op, evidence: freeze(evidence), configSha256: expectedSha256 });
  } catch { return deny(); }
}

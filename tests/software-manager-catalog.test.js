import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  compareVersions,
  MAX_SOFTWARE_PACKAGE_BYTES,
  parseCatalog,
  resolveCatalogAssetUrl,
} from "../shared/software-manager/catalog-schema.mjs";
import {
  createTrustedCatalogService,
  isTrustedCatalogService,
  verifyCatalogEnvelope,
} from "../desktop/software-manager/catalog-trust.mjs";

const TEST_CATALOG_URL = "https://shanhaiyouling.com/codexbridge-install-test/component-catalog.json";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" });

function componentFixture(overrides = {}) {
  return {
    id: "chatgpt",
    name: "ChatGPT",
    version: "1.2.3",
    architecture: "x64",
    format: "zip",
    assetUrl: "https://shanhaiyouling.com/codexbridge-test/packages/chatgpt-1.2.3.zip",
    size: 1234,
    sha256: "a".repeat(64),
    entrypoint: "ChatGPT.exe",
    requiredFiles: ["ChatGPT.exe"],
    maxRelativePathLength: 240,
    publishedAt: "2026-08-07T00:00:00.000Z",
    supportsRollback: true,
    ...overrides,
  };
}

function skillFixture(id, overrides = {}) {
  return {
    id,
    name: "Documents",
    description: "Create and edit documents.",
    version: "1.2.3",
    assetUrl: `https://shanhaiyouling.com/codexbridge-test/packages/skills/${id}.zip`,
    size: 1234,
    sha256: "b".repeat(64),
    files: ["SKILL.md"],
    ...overrides,
  };
}

function signedFixture({ components = [], skills = [] } = {}) {
  const jsonBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, components, skills }));
  return {
    jsonBytes,
    signatureText: sign("RSA-SHA256", jsonBytes, privateKey).toString("base64"),
    publicKeyPem: PUBLIC_KEY_PEM,
  };
}

test("catalog accepts a signed test-origin manifest", () => {
  const signed = signedFixture({ components: [componentFixture()], skills: [skillFixture("documents")] });
  const result = verifyCatalogEnvelope({ ...signed, catalogUrl: TEST_CATALOG_URL });
  assert.equal(result.components[0].id, "chatgpt");
});

test("catalog uses one software package byte ceiling for components and Skills", () => {
  const accepted = parseCatalog({
    schemaVersion: 1,
    components: [componentFixture({ size: MAX_SOFTWARE_PACKAGE_BYTES })],
    skills: [skillFixture("documents", { size: MAX_SOFTWARE_PACKAGE_BYTES })],
  });
  assert.equal(accepted.components[0].size, MAX_SOFTWARE_PACKAGE_BYTES);
  assert.equal(accepted.skills[0].size, MAX_SOFTWARE_PACKAGE_BYTES);
  assert.throws(() => parseCatalog({
    schemaVersion: 1,
    components: [componentFixture({ size: MAX_SOFTWARE_PACKAGE_BYTES + 1 })],
    skills: [],
  }), /catalog_component_invalid/u);
  assert.throws(() => parseCatalog({
    schemaVersion: 1,
    components: [],
    skills: [skillFixture("documents", { size: MAX_SOFTWARE_PACKAGE_BYTES + 1 })],
  }), /catalog_skill_invalid/u);
});

test("only a signature-verified catalog can issue a fixed-ID catalog service", () => {
  const signed = signedFixture({ components: [componentFixture()], skills: [skillFixture("documents")] });
  const verified = verifyCatalogEnvelope({ ...signed, catalogUrl: TEST_CATALOG_URL });
  const service = createTrustedCatalogService(verified);
  assert.equal(isTrustedCatalogService(service), true);
  assert.equal(service.getComponent("chatgpt").assetUrl, "https://shanhaiyouling.com/codexbridge-test/packages/chatgpt-1.2.3.zip");
  assert.equal(service.getSkill("documents").id, "documents");
  assert.throws(() => service.getComponent("unknown"), /catalog_component_id_invalid/);
  assert.throws(() => createTrustedCatalogService(parseCatalog({
    schemaVersion: 1, components: [componentFixture()], skills: [],
  })), /catalog_not_verified/);
});

test("catalog rejects a signature after one JSON byte changes", () => {
  const signed = signedFixture({ components: [componentFixture()] });
  assert.throws(
    () => verifyCatalogEnvelope({ ...signed, jsonBytes: Buffer.concat([signed.jsonBytes, Buffer.from(" ")]), catalogUrl: TEST_CATALOG_URL }),
    /signature/i,
  );
});

test("catalog rejects signed JSON bytes that are not valid UTF-8 before parsing", () => {
  const jsonBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    components: [componentFixture()],
    skills: [],
  }));
  const nameOffset = jsonBytes.indexOf(Buffer.from("ChatGPT"));
  assert.notEqual(nameOffset, -1);
  jsonBytes[nameOffset] = 0xff;
  const signatureText = sign("RSA-SHA256", jsonBytes, privateKey).toString("base64");

  assert.throws(
    () => verifyCatalogEnvelope({ jsonBytes, signatureText, publicKeyPem: PUBLIC_KEY_PEM, catalogUrl: TEST_CATALOG_URL }),
    (error) => error?.code === "catalog_json_invalid",
  );
});

test("catalog rejects an unknown component ID", () => {
  assert.throws(() => parseCatalog({ schemaVersion: 1, components: [componentFixture({ id: "unknown" })], skills: [] }), /component_id/i);
});

test("catalog rejects a non-HTTPS asset URL", () => {
  assert.throws(() => parseCatalog({ schemaVersion: 1, components: [componentFixture({ assetUrl: "http://example.test/chatgpt.zip" })], skills: [] }), /asset_url/i);
});

test("catalog rejects an external HTTPS asset URL", () => {
  assert.throws(() => parseCatalog({ schemaVersion: 1, components: [componentFixture({ assetUrl: "https://example.test/chatgpt.zip" })], skills: [] }), /asset_url/i);
});

test("catalog accepts only the isolated immutable COS package prefix", () => {
  assert.equal(resolveCatalogAssetUrl(TEST_CATALOG_URL,
    "https://codex-1431412335.cos.ap-guangzhou.myqcloud.com/codexbridge-test/packages/chatgpt-1.2.3.zip"),
  "https://codex-1431412335.cos.ap-guangzhou.myqcloud.com/codexbridge-test/packages/chatgpt-1.2.3.zip");
  assert.throws(() => resolveCatalogAssetUrl(TEST_CATALOG_URL,
    "https://codex-1431412335.cos.ap-guangzhou.myqcloud.com/packages/chatgpt-1.2.3.zip"),
  /catalog_asset_url_rejected/);
});

test("catalog rejects an asset in the old production path", () => {
  assert.throws(() => parseCatalog({ schemaVersion: 1, components: [componentFixture({ assetUrl: "https://shanhaiyouling.com/codexbridge-install/packages/chatgpt.zip" })], skills: [] }), /asset_url/i);
});

test("catalog rejects encoded traversal in an asset URL", () => {
  assert.throws(() => parseCatalog({ schemaVersion: 1, components: [componentFixture({ assetUrl: "https://shanhaiyouling.com/codexbridge-test/packages/%2e%2e/escape.zip" })], skills: [] }), /asset_url/i);
});

test("catalog rejects asset URL queries and fragments", () => {
  assert.throws(() => parseCatalog({ schemaVersion: 1, components: [componentFixture({ assetUrl: "https://shanhaiyouling.com/codexbridge-test/packages/chatgpt.zip?token=x" })], skills: [] }), /asset_url/i);
  assert.throws(() => parseCatalog({ schemaVersion: 1, components: [componentFixture({ assetUrl: "https://shanhaiyouling.com/codexbridge-test/packages/chatgpt.zip#fragment" })], skills: [] }), /asset_url/i);
});

test("catalog rejects duplicate Skill IDs", () => {
  assert.throws(() => parseCatalog({ schemaVersion: 1, components: [], skills: [skillFixture("documents"), skillFixture("documents")] }), /skill_id_duplicate/i);
});

test("catalog rejects path-bearing Skill IDs", () => {
  assert.throws(() => parseCatalog({ schemaVersion: 1, components: [], skills: [skillFixture("../documents")] }), /skill_id/i);
});

test("catalog rejects a production-origin URL", () => {
  const signed = signedFixture({ components: [componentFixture()] });
  assert.throws(
    () => verifyCatalogEnvelope({ ...signed, catalogUrl: "https://shanhaiyouling.com/codexbridge-install/component-catalog.json" }),
    /catalog_origin_rejected/,
  );
});

test("catalog resolves an authorized test package asset URL", () => {
  assert.equal(resolveCatalogAssetUrl(TEST_CATALOG_URL, "https://shanhaiyouling.com/codexbridge-test/packages/chatgpt.zip"), "https://shanhaiyouling.com/codexbridge-test/packages/chatgpt.zip");
});

test("catalog trust rejects a catalog signed by a key other than the pinned publisher", () => {
  const signed = signedFixture({ components: [componentFixture()] });
  const { publicKeyPem, ...unsignedRuntime } = signed;
  assert.throws(() => verifyCatalogEnvelope({ ...unsignedRuntime, catalogUrl: TEST_CATALOG_URL }), /catalog_signature_invalid/);
});

test("catalog compares numeric version segments", () => {
  assert.equal(compareVersions("1.10.0", "1.2.0"), 1);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("1.2.0", "1.2.1"), -1);
});

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  compareVersions,
  parseCatalog,
  resolveCatalogAssetUrl,
} from "../shared/software-manager/catalog-schema.mjs";
import { verifyCatalogEnvelope } from "../desktop/software-manager/catalog-trust.mjs";

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
    assetUrl: "assets/chatgpt-1.2.3.zip",
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
    assetUrl: `assets/skills/${id}.zip`,
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

test("catalog rejects a signature after one JSON byte changes", () => {
  const signed = signedFixture({ components: [componentFixture()] });
  assert.throws(
    () => verifyCatalogEnvelope({ ...signed, jsonBytes: Buffer.concat([signed.jsonBytes, Buffer.from(" ")]), catalogUrl: TEST_CATALOG_URL }),
    /signature/i,
  );
});

test("catalog rejects an unknown component ID", () => {
  assert.throws(() => parseCatalog({ schemaVersion: 1, components: [componentFixture({ id: "unknown" })], skills: [] }), /component_id/i);
});

test("catalog rejects a non-HTTPS asset URL", () => {
  assert.throws(() => parseCatalog({ schemaVersion: 1, components: [componentFixture({ assetUrl: "http://example.test/chatgpt.zip" })], skills: [] }), /asset_url/i);
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

test("catalog resolves relative asset URLs against the signed catalog URL", () => {
  assert.equal(resolveCatalogAssetUrl(TEST_CATALOG_URL, "assets/chatgpt.zip"), "https://shanhaiyouling.com/codexbridge-install-test/assets/chatgpt.zip");
});

test("catalog compares numeric version segments", () => {
  assert.equal(compareVersions("1.10.0", "1.2.0"), 1);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("1.2.0", "1.2.1"), -1);
});

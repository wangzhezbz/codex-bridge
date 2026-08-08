import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyCatalogEnvelope } from "../desktop/software-manager/catalog-trust.mjs";
import { buildCatalogBytes } from "../scripts/software-manager/catalog-builder.mjs";
import { loadPublisherConfig } from "../scripts/software-manager/publisher-config.mjs";
import { publishChatGPT } from "../scripts/software-manager/publish-chatgpt.mjs";
import { publishImportedAssets } from "../scripts/software-manager/publish-imported-assets.mjs";
import { publishSkills } from "../scripts/software-manager/publish-skills.mjs";

const PACKAGE_BASE_URL = "https://shanhaiyouling.com/codexbridge-test/packages/";
const CATALOG_URL = "https://shanhaiyouling.com/codexbridge-install-test/component-catalog.json";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-publisher-"));
  const publicRoot = path.join(root, "public");
  const inputRoot = path.join(root, "input");
  fs.mkdirSync(publicRoot);
  fs.mkdirSync(inputRoot);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signingKeyFile = path.join(root, "catalog-signing-private.pem");
  fs.writeFileSync(signingKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return {
    root,
    publicRoot,
    inputRoot,
    signingKeyFile,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    env: {
      CBI_SIGNING_KEY_FILE: signingKeyFile,
      CBI_PUBLIC_ROOT: publicRoot,
      CBI_PACKAGE_BASE_URL: PACKAGE_BASE_URL,
    },
  };
}

function createChatGPTSource(parent, version) {
  const source = path.join(parent, `chatgpt-${version}`);
  fs.mkdirSync(path.join(source, "resources"), { recursive: true });
  fs.writeFileSync(path.join(source, "ChatGPT.exe"), `chatgpt-${version}`);
  fs.writeFileSync(path.join(source, "resources", "app.asar"), `asar-${version}`);
  return source;
}

function catalogEnvelope(result, fixtureValue) {
  return verifyCatalogEnvelope({
    jsonBytes: fs.readFileSync(result.catalogPath),
    signatureText: fs.readFileSync(result.signaturePath, "utf8").trim(),
    publicKeyPem: fixtureValue.publicKeyPem,
    catalogUrl: CATALOG_URL,
  });
}

test("publisher config needs no object-storage credentials and rejects historical roots", () => {
  const value = fixture();
  const config = loadPublisherConfig(value.env);
  assert.equal(config.publicRoot, value.publicRoot);
  assert.equal(config.packageBaseUrl, PACKAGE_BASE_URL);
  assert.equal(Object.keys(config).some((key) => /token|secret|access.*key/i.test(key)), false);
  assert.throws(() => loadPublisherConfig({
    ...value.env,
    CBI_PUBLIC_ROOT: path.join(path.parse(value.publicRoot).root, "opt", "shanhai", "codex-installer"),
  }), /publisher_public_root_rejected/);
  assert.throws(() => loadPublisherConfig({
    ...value.env,
    CBI_PUBLIC_ROOT: path.join(value.root, "install-test", "public"),
  }), /publisher_public_root_rejected/);
  assert.throws(() => loadPublisherConfig({
    ...value.env,
    CBI_PACKAGE_BASE_URL: "https://shanhaiyouling.com/install-test/packages/",
  }), /publisher_package_base_url_rejected/);
});

test("catalog bytes are deterministic, recursively key-sorted and LF terminated", () => {
  const left = buildCatalogBytes({
    skills: [],
    components: [{ z: 1, id: "chatgpt", nested: { z: 2, a: 1 }, a: 2 }],
    schemaVersion: 1,
  });
  const right = buildCatalogBytes({
    schemaVersion: 1,
    components: [{ nested: { a: 1, z: 2 }, a: 2, id: "chatgpt", z: 1 }],
    skills: [],
  });
  assert.deepEqual(left, right);
  assert.equal(left.at(-1), 0x0a);
  assert.equal(left.includes(0x0d), false);
});

test("ChatGPT publisher normalizes an explicit local tree and replaces the signed catalog last", async () => {
  const value = fixture();
  const inputPath = createChatGPTSource(value.inputRoot, "1.2.3");
  const result = await publishChatGPT({
    config: loadPublisherConfig(value.env),
    inputPath,
    version: "1.2.3",
    publishedAt: "2026-08-08T00:00:00.000Z",
    versionInspector: async (entrypoint) => {
      assert.equal(entrypoint, path.join(inputPath, "ChatGPT.exe"));
      return "1.2.3";
    },
  });

  assert.deepEqual(result.events.slice(-3), ["package_verified", "signature_written", "catalog_replaced"]);
  const catalog = catalogEnvelope(result, value);
  assert.equal(catalog.components[0].id, "chatgpt");
  assert.equal(catalog.components[0].version, "1.2.3");
  assert.equal(catalog.components[0].entrypoint, "ChatGPT.exe");
  assert.deepEqual(catalog.components[0].requiredFiles, ["ChatGPT.exe", "resources/app.asar"]);
  assert.equal(catalog.components[0].maxRelativePathLength, "resources/app.asar".length);
  assert.equal(fs.statSync(result.packagePath).size, catalog.components[0].size);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(result.packagePath)).digest("hex"), catalog.components[0].sha256);
});

test("publisher refuses immutable-name overwrite and retains only current plus one fallback package", async () => {
  const value = fixture();
  const config = loadPublisherConfig(value.env);
  for (const version of ["1.0.0", "2.0.0", "3.0.0"]) {
    await publishChatGPT({
      config,
      inputPath: createChatGPTSource(value.inputRoot, version),
      version,
      publishedAt: `2026-08-0${Number(version[0])}T00:00:00.000Z`,
      versionInspector: async () => version,
    });
  }
  const packages = fs.readdirSync(path.join(value.publicRoot, "packages"))
    .filter((name) => /^chatgpt-.*\.zip$/u.test(name)).sort();
  assert.deepEqual(packages, ["chatgpt-2.0.0-x64.zip", "chatgpt-3.0.0-x64.zip"]);
  await assert.rejects(publishChatGPT({
    config,
    inputPath: createChatGPTSource(value.inputRoot, "3.0.0-copy"),
    version: "3.0.0",
    publishedAt: "2026-08-04T00:00:00.000Z",
    versionInspector: async () => "3.0.0",
  }), /publisher_immutable_object_exists/);
});

test("Skills publisher accepts only direct safe children with SKILL.md and signs the resulting catalog", async () => {
  const value = fixture();
  const skillsRoot = path.join(value.inputRoot, "skills");
  fs.mkdirSync(path.join(skillsRoot, "documents", "references"), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, "documents", "SKILL.md"), "# Documents\n");
  fs.writeFileSync(path.join(skillsRoot, "documents", "references", "guide.md"), "guide\n");
  const result = await publishSkills({
    config: loadPublisherConfig(value.env),
    inputRoot: skillsRoot,
    version: "1.0.0",
    publishedAt: "2026-08-08T00:00:00.000Z",
    descriptions: { documents: "Create and edit documents." },
  });
  const catalog = catalogEnvelope(result, value);
  assert.deepEqual(catalog.skills.map((skill) => skill.id), ["documents"]);
  assert.deepEqual(catalog.skills[0].files, ["SKILL.md", "references/guide.md"]);

  fs.mkdirSync(path.join(skillsRoot, "MissingSkill"));
  await assert.rejects(publishSkills({
    config: loadPublisherConfig(value.env), inputRoot: skillsRoot, version: "1.0.1",
  }), /publisher_skill_id_invalid|publisher_skill_entrypoint_missing/);
});

test("publisher rejects duplicate case-folded Skill IDs before writing packages", async () => {
  const value = fixture();
  const skillsRoot = path.join(value.inputRoot, "skills");
  for (const id of ["documents", "DOCUMENTS"]) {
    fs.mkdirSync(path.join(skillsRoot, id), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, id, "SKILL.md"), `# ${id}\n`);
  }
  await assert.rejects(publishSkills({
    config: loadPublisherConfig(value.env),
    inputRoot: skillsRoot,
    version: "1.0.0",
    readDirectory: () => [
      { name: "documents", isDirectory: () => true },
      { name: "DOCUMENTS", isDirectory: () => true },
    ],
  }), /publisher_skill_id_duplicate|publisher_skill_id_invalid/);
  assert.equal(fs.existsSync(path.join(value.publicRoot, "component-catalog.json")), false);
});

test("publisher refuses to re-sign a catalog whose existing detached signature no longer matches", async () => {
  const value = fixture();
  const config = loadPublisherConfig(value.env);
  await publishChatGPT({
    config,
    inputPath: createChatGPTSource(value.inputRoot, "1.0.0"),
    version: "1.0.0",
    versionInspector: async () => "1.0.0",
  });
  const catalogPath = path.join(value.publicRoot, "component-catalog.json");
  const tampered = fs.readFileSync(catalogPath, "utf8").replace("ChatGPT", "ChatGpt");
  fs.writeFileSync(catalogPath, tampered);
  await assert.rejects(publishChatGPT({
    config,
    inputPath: createChatGPTSource(value.inputRoot, "2.0.0"),
    version: "2.0.0",
    versionInspector: async () => "2.0.0",
  }), /publisher_existing_catalog_signature_invalid/);
});

test("imported asset publisher verifies local immutable objects before signing", async () => {
  const value = fixture();
  const packageRoot = path.join(value.publicRoot, "packages");
  const skillRoot = path.join(packageRoot, "skills");
  fs.mkdirSync(skillRoot, { recursive: true });
  const chatgptPath = path.join(packageRoot, "chatgpt-1.2.3-x64.zip");
  const skillPath = path.join(skillRoot, "documents-1.0.0.zip");
  fs.writeFileSync(chatgptPath, "chatgpt-package");
  fs.writeFileSync(skillPath, "skill-package");
  const asset = (filePath) => ({
    size: fs.statSync(filePath).size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
  });
  const metadataPath = path.join(value.root, "import.json");
  fs.writeFileSync(metadataPath, JSON.stringify({
    component: {
      id: "chatgpt", name: "ChatGPT", version: "1.2.3", architecture: "x64", format: "zip",
      assetUrl: `${PACKAGE_BASE_URL}chatgpt-1.2.3-x64.zip`, ...asset(chatgptPath),
      entrypoint: "ChatGPT.exe", requiredFiles: ["ChatGPT.exe"], maxRelativePathLength: 11,
      publishedAt: "2026-08-08T00:00:00.000Z", supportsRollback: true,
    },
    skills: [{
      id: "documents", name: "Documents", description: "Document processing.", version: "1.0.0",
      assetUrl: `${PACKAGE_BASE_URL}skills/documents-1.0.0.zip`, ...asset(skillPath), files: ["SKILL.md"],
    }],
  }));
  const result = await publishImportedAssets({
    config: loadPublisherConfig(value.env), metadataPath,
  });
  assert.deepEqual(result.events, ["imported_assets_verified", "signature_written", "catalog_replaced"]);
  const catalog = catalogEnvelope(result, value);
  assert.equal(catalog.components[0].version, "1.2.3");
  assert.deepEqual(catalog.skills.map((skill) => skill.id), ["documents"]);

  fs.writeFileSync(skillPath, "tampered");
  await assert.rejects(publishImportedAssets({
    config: loadPublisherConfig(value.env), metadataPath,
  }), /publisher_import_asset_verification_failed/);
});

test("package.json exposes explicit manual ChatGPT and Skills publisher commands", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(packageJson.scripts["software:publish:chatgpt"], "node scripts/software-manager/publish-chatgpt.mjs");
  assert.equal(packageJson.scripts["software:publish:skills"], "node scripts/software-manager/publish-skills.mjs");
  assert.equal(packageJson.scripts["software:publish:imported"], "node scripts/software-manager/publish-imported-assets.mjs");
});

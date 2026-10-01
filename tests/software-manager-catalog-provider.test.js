import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { createCatalogCache } from "../desktop/software-manager/catalog-cache.mjs";
import { createCachedCatalogProvider } from "../desktop/software-manager/catalog-provider.mjs";
import { readBundledCatalogEnvelope } from "../desktop/software-manager/bundled-catalog.mjs";
import { CATALOG_PUBLIC_KEY_SPKI } from "../desktop/software-manager/catalog-public-key.mjs";
import { createSoftwareManagerService } from "../desktop/software-manager/service.mjs";

const TEST_CATALOG_URL = "https://shanhaiyouling.com/codexbridge-install-test/component-catalog.json";
const TEST_SIGNATURE_URL = `${TEST_CATALOG_URL}.sig`;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" });

function catalogFixture(version = "1.2.3") {
  return {
    schemaVersion: 1,
    components: [{
      id: "chatgpt",
      name: "ChatGPT",
      version,
      architecture: "x64",
      format: "zip",
      assetUrl: `https://shanhaiyouling.com/codexbridge-test/packages/chatgpt-${version}.zip`,
      size: 1234,
      sha256: "a".repeat(64),
      entrypoint: "ChatGPT.exe",
      requiredFiles: ["ChatGPT.exe"],
      maxRelativePathLength: 240,
      publishedAt: "2026-08-07T00:00:00.000Z",
      supportsRollback: true,
    }],
    skills: [],
  };
}

function signedFixture(version = "1.2.3", overrides = {}) {
  const jsonBytes = Buffer.from(JSON.stringify({ ...catalogFixture(version), ...overrides }));
  return {
    catalogUrl: TEST_CATALOG_URL,
    jsonBytes,
    signatureText: sign("RSA-SHA256", jsonBytes, privateKey).toString("base64"),
  };
}

function memoryCacheStore(initial = null) {
  let record = initial === null ? null : structuredClone(initial);
  const replacements = [];
  return {
    replacements,
    async read() { return record === null ? null : structuredClone(record); },
    async replaceAtomic(next) {
      replacements.push(structuredClone(next));
      record = structuredClone(next);
    },
    snapshot() { return record === null ? null : structuredClone(record); },
  };
}

function response(body, { status = 200, headers } = {}) {
  return new Response(body, { status, headers });
}

function trackedStream(chunks) {
  let index = 0;
  const state = { cancelled: false };
  const body = new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) controller.close();
      else controller.enqueue(Buffer.from(chunks[index++]));
    },
    cancel() { state.cancelled = true; },
  });
  return { body, state };
}

function providerOptions(overrides = {}) {
  return {
    catalogUrl: TEST_CATALOG_URL,
    signatureUrl: TEST_SIGNATURE_URL,
    publicKeyPem: PUBLIC_KEY_PEM,
    fetchImpl: async () => { throw new Error("unexpected_fetch"); },
    cache: { readEnvelope: async () => null, replaceEnvelope: async () => {} },
    ...overrides,
  };
}

function completeSignedFixture(version) {
  const template = catalogFixture(version).components[0];
  return signedFixture(version, {
    components: ["chatgpt", "v2rayn", "git"].map((id) => ({
      ...template,
      id,
      name: id,
      assetUrl: `https://shanhaiyouling.com/codexbridge-test/packages/${id}-${version}.zip`,
      entrypoint: `${id}.exe`,
      requiredFiles: [`${id}.exe`],
    })),
  });
}

function installationProbeService(catalogProvider, preparedTargets, installedVersion = null) {
  return createSoftwareManagerService({
    platform: "win32",
    catalogProvider,
    ownershipStore: { load: async () => ({ activeTask: null, components: {}, skills: {}, rollback: null }) },
    installRootResolver: {
      choose: async () => ({ token: "root_token_00000001", capability: {} }),
      resolve: async () => ({}),
      getCurrentToken: () => "root_token_00000001",
      adopt: async () => {},
      discard: async () => {},
    },
    adapterFactory: ({ catalogService }) => Object.fromEntries(["chatgpt", "v2rayn", "git"].map((id) => {
      const entry = catalogService.getComponent(id);
      const result = (action, status, versionAfter) => ({
        componentId: id, action, status, versionBefore: installedVersion,
        versionAfter, message: `probe_${action}`, rollbackAvailable: false,
      });
      return [id, {
        inspectInstalled: async () => result("inspect", installedVersion ? "succeeded" : "skipped", installedVersion),
        prepare: async () => {
          preparedTargets.push({ id, version: entry.version, assetUrl: entry.assetUrl });
          return result("prepare", "succeeded", entry.version);
        },
        // Package and filesystem work stop at this in-memory adapter boundary.
        commit: async () => result("commit", "succeeded", entry.version),
      }];
    })),
  });
}

test("null public key is offline and leaves network and cache untouched", async () => {
  const calls = { fetch: 0, read: 0, write: 0 };
  const provider = createCachedCatalogProvider(providerOptions({
    publicKeyPem: null,
    fetchImpl: async () => { calls.fetch += 1; throw new Error("network_forbidden"); },
    cache: {
      readEnvelope: async () => { calls.read += 1; return null; },
      replaceEnvelope: async () => { calls.write += 1; },
    },
  }));

  assert.equal(await provider.getCurrent(), null);
  assert.equal(await provider.refresh(), null);
  assert.deepEqual(calls, { fetch: 0, read: 0, write: 0 });
});

test("provider accepts only the fixed HTTPS catalog and matching signature URLs", () => {
  for (const overrides of [
    { catalogUrl: `http://shanhaiyouling.com/codexbridge-install-test/component-catalog.json` },
    { catalogUrl: `${TEST_CATALOG_URL}?next=1` },
    { catalogUrl: "https://shanhaiyouling.com/codexbridge-install/component-catalog.json" },
    { signatureUrl: `${TEST_CATALOG_URL}.other` },
    { signatureUrl: `${TEST_SIGNATURE_URL}?token=x` },
  ]) {
    assert.throws(() => createCachedCatalogProvider(providerOptions(overrides)), /catalog_provider_url_rejected/u);
  }
});

test("catalog cache atomically replaces one exact bounded envelope record", async () => {
  const store = memoryCacheStore();
  const cache = createCatalogCache({ cacheStore: store });
  const envelope = signedFixture();

  await cache.replaceEnvelope(envelope);

  assert.equal(store.replacements.length, 1);
  assert.deepEqual(Object.keys(store.replacements[0]).sort(), ["catalogUrl", "jsonBase64", "signatureText"]);
  assert.deepEqual(await cache.readEnvelope(), envelope);
});

test("catalog cache requires the narrow atomic replacement capability", () => {
  assert.throws(
    () => createCatalogCache({ cacheStore: { read: async () => null, replace: async () => {} } }),
    /catalog_cache_store_invalid/u,
  );
});

test("catalog cache calls only replaceAtomic even when a weak replace method is present", async () => {
  const calls = [];
  const cache = createCatalogCache({
    cacheStore: {
      read: async () => null,
      replace: async () => { calls.push("replace"); },
      replaceAtomic: async () => { calls.push("replaceAtomic"); },
    },
  });

  await cache.replaceEnvelope(signedFixture());

  assert.deepEqual(calls, ["replaceAtomic"]);
});

test("an atomic cache replacement failure leaves the prior envelope readable", async () => {
  const prior = signedFixture("1.0.0");
  const incoming = signedFixture("2.0.0");
  const priorRecord = {
    catalogUrl: prior.catalogUrl,
    jsonBase64: prior.jsonBytes.toString("base64"),
    signatureText: prior.signatureText,
  };
  const store = {
    async read() { return structuredClone(priorRecord); },
    async replaceAtomic() { throw new Error("atomic_replace_failed"); },
  };
  const cache = createCatalogCache({ cacheStore: store });

  await assert.rejects(cache.replaceEnvelope(incoming), /atomic_replace_failed/u);
  assert.deepEqual(await cache.readEnvelope(), prior);
});

test("catalog cache rejects malformed, oversized, and non-canonical single records", async () => {
  const valid = signedFixture();
  const validRecord = {
    catalogUrl: valid.catalogUrl,
    jsonBase64: valid.jsonBytes.toString("base64"),
    signatureText: valid.signatureText,
  };
  const invalidRecords = [
    { ...validRecord, extra: true },
    { ...validRecord, catalogUrl: `${TEST_CATALOG_URL}?x=1` },
    { ...validRecord, jsonBase64: "%%%" },
    { ...validRecord, jsonBase64: `${validRecord.jsonBase64}= ` },
    { ...validRecord, jsonBase64: Buffer.alloc(2_000_001).toString("base64") },
    { ...validRecord, signatureText: `${valid.signatureText}\n` },
    { ...validRecord, signatureText: "%%%" },
    { ...validRecord, signatureText: "AB==" },
    { ...validRecord, signatureText: "a".repeat(16_385) },
  ];

  for (const record of invalidRecords) {
    const cache = createCatalogCache({ cacheStore: memoryCacheStore(record) });
    await assert.rejects(cache.readEnvelope(), /catalog_cache_invalid/u);
  }
});

test("catalog cache exact schema rejects symbol keys, accessors, and hostile records", async () => {
  const valid = signedFixture();
  const record = {
    catalogUrl: valid.catalogUrl,
    jsonBase64: valid.jsonBytes.toString("base64"),
    signatureText: valid.signatureText,
  };
  const symbolRecord = { ...record, [Symbol("extra")]: true };
  const accessorRecord = { ...record };
  let cacheAccessorReads = 0;
  Object.defineProperty(accessorRecord, "signatureText", {
    enumerable: true,
    get() { cacheAccessorReads += 1; return valid.signatureText; },
  });
  const hostileRecord = new Proxy(record, {
    getPrototypeOf() { throw new Error("hostile_cache_record"); },
  });

  for (const value of [symbolRecord, accessorRecord, hostileRecord]) {
    const cache = createCatalogCache({
      cacheStore: { read: async () => value, replaceAtomic: async () => {} },
    });
    await assert.rejects(cache.readEnvelope(), /catalog_cache_invalid/u);
  }
  assert.equal(cacheAccessorReads, 0);
});

test("catalog cache maps nested byte traps to its cache error without invoking hostile species", async () => {
  const envelope = signedFixture();
  class HostileValueBytes extends Uint8Array {
    valueOf() { throw new Error("nested_valueof_trap"); }
  }
  let speciesReads = 0;
  class HostileSpeciesBytes extends Uint8Array {
    static get [Symbol.species]() {
      speciesReads += 1;
      throw new Error("nested_species_trap");
    }
  }
  const trappedPrototype = new Proxy(new Uint8Array(envelope.jsonBytes), {
    getPrototypeOf() { throw new Error("nested_getprototypeof_trap"); },
  });
  const trappedProxy = new Proxy(new Uint8Array(envelope.jsonBytes), {});
  const trappedValue = new HostileValueBytes(envelope.jsonBytes);

  const cache = createCatalogCache({ cacheStore: memoryCacheStore() });
  for (const jsonBytes of [trappedPrototype, trappedProxy, trappedValue]) {
    await assert.rejects(
      cache.replaceEnvelope({ ...envelope, jsonBytes }),
      (error) => error?.code === "catalog_cache_invalid",
    );
  }
  await cache.replaceEnvelope({ ...envelope, jsonBytes: new HostileSpeciesBytes(envelope.jsonBytes) });
  assert.equal(speciesReads, 0);
});

test("catalog cache decode rejects hostile nested scalar proxies without reading their traps", async () => {
  const envelope = signedFixture();
  let scalarTrapReads = 0;
  const hostileBase64 = new Proxy(new String(envelope.jsonBytes.toString("base64")), {
    get(_target, _property) { scalarTrapReads += 1; throw new Error("nested_scalar_trap"); },
  });
  const cache = createCatalogCache({
    cacheStore: {
      read: async () => ({
        catalogUrl: envelope.catalogUrl,
        jsonBase64: hostileBase64,
        signatureText: envelope.signatureText,
      }),
      replaceAtomic: async () => {},
    },
  });

  await assert.rejects(cache.readEnvelope(), (error) => error?.code === "catalog_cache_invalid");
  assert.equal(scalarTrapReads, 0);
});

test("getCurrent re-verifies a valid cached envelope before returning a trusted service", async () => {
  const envelope = signedFixture();
  const store = memoryCacheStore({
    catalogUrl: envelope.catalogUrl,
    jsonBase64: envelope.jsonBytes.toString("base64"),
    signatureText: envelope.signatureText,
  });
  const provider = createCachedCatalogProvider(providerOptions({ cache: createCatalogCache({ cacheStore: store }) }));

  const service = await provider.getCurrent();

  assert.equal(service.getComponent("chatgpt").version, "1.2.3");
});

test("getCurrent uses the signed bundled catalog when a new machine has no cache", async () => {
  const bundledEnvelope = signedFixture("4.5.6");
  const provider = createCachedCatalogProvider(providerOptions({ bundledEnvelope }));

  const service = await provider.getCurrent();

  assert.equal(service.getComponent("chatgpt").version, "4.5.6");
});

test("getCurrent never lets a valid but stale cache downgrade the signed bundled baseline", async () => {
  const cached = signedFixture("1.0.0");
  const bundledEnvelope = signedFixture("4.5.6");
  const provider = createCachedCatalogProvider(providerOptions({
    bundledEnvelope,
    cache: { readEnvelope: async () => cached, replaceEnvelope: async () => {} },
  }));

  const service = await provider.getCurrent();

  assert.equal(service.getComponent("chatgpt").version, "4.5.6");
});

test("getCurrent keeps a cache that is newer than the signed bundled baseline", async () => {
  const cached = signedFixture("5.0.0");
  const bundledEnvelope = signedFixture("4.5.6");
  const provider = createCachedCatalogProvider(providerOptions({
    bundledEnvelope,
    cache: { readEnvelope: async () => cached, replaceEnvelope: async () => {} },
  }));

  const service = await provider.getCurrent();

  assert.equal(service.getComponent("chatgpt").version, "5.0.0");
});

test("the production bundled catalog works offline on a first-run machine", async () => {
  const provider = createCachedCatalogProvider({
    catalogUrl: TEST_CATALOG_URL,
    signatureUrl: TEST_SIGNATURE_URL,
    publicKeyPem: CATALOG_PUBLIC_KEY_SPKI,
    fetchImpl: async () => { throw new Error("offline"); },
    cache: { readEnvelope: async () => null, replaceEnvelope: async () => {} },
    bundledEnvelope: readBundledCatalogEnvelope({ catalogUrl: TEST_CATALOG_URL }),
  });

  const service = await provider.getCurrent();

  assert.equal(service.getComponent("chatgpt").version, "26.928.3736.0");
  assert.equal(service.getComponent("chatgpt").sha256, "d48ed3a9b9100ea9a6464ad658ee7b3cffc70b8024ff32865f768820e7850244");
  assert.equal(service.getComponent("chatgpt").assetUrl, "https://download.shanhaiyouling.com/codexbridge-test/packages/chatgpt-26.928.3736.0-x64.zip");
  assert.equal(service.getComponent("v2rayn").version, "7.25.2.0");
  assert.equal(service.getComponent("git").version, "2.56.0");
  assert.equal(service.listSkills().length, 7);
});

test("getCurrent uses the signed bundled catalog when the local cache is corrupt", async () => {
  const cached = signedFixture("1.0.0");
  const bundledEnvelope = signedFixture("4.5.6");
  const provider = createCachedCatalogProvider(providerOptions({
    bundledEnvelope,
    cache: {
      readEnvelope: async () => ({ ...cached, signatureText: Buffer.alloc(256).toString("base64") }),
      replaceEnvelope: async () => {},
    },
  }));

  const service = await provider.getCurrent();

  assert.equal(service.getComponent("chatgpt").version, "4.5.6");
});

test("provider rejects a bundled catalog whose signature is invalid", () => {
  const bundledEnvelope = {
    ...signedFixture("4.5.6"),
    signatureText: Buffer.alloc(256).toString("base64"),
  };

  assert.throws(
    () => createCachedCatalogProvider(providerOptions({ bundledEnvelope })),
    /catalog_signature_invalid/u,
  );
});

test("getCurrent fails closed when the cached envelope signature is corrupt", async () => {
  const envelope = signedFixture();
  const store = memoryCacheStore({
    catalogUrl: envelope.catalogUrl,
    jsonBase64: envelope.jsonBytes.toString("base64"),
    signatureText: Buffer.alloc(256).toString("base64"),
  });
  const provider = createCachedCatalogProvider(providerOptions({ cache: createCatalogCache({ cacheStore: store }) }));

  await assert.rejects(provider.getCurrent(), /catalog_signature_invalid/u);
});

test("getCurrent rejects a cache implementation that changes the envelope catalog URL", async () => {
  const envelope = signedFixture();
  const provider = createCachedCatalogProvider(providerOptions({
    cache: {
      readEnvelope: async () => ({ ...envelope, catalogUrl: `${TEST_CATALOG_URL}?source=cache` }),
      replaceEnvelope: async () => {},
    },
  }));

  await assert.rejects(provider.getCurrent(), /catalog_cache_url_mismatch/u);
});

test("getCurrent independently rejects malformed or aliased cache envelope records", async () => {
  const envelope = signedFixture();
  const accessorEnvelope = { ...envelope };
  let providerAccessorReads = 0;
  Object.defineProperty(accessorEnvelope, "signatureText", {
    enumerable: true,
    get() { providerAccessorReads += 1; return envelope.signatureText; },
  });
  const symbolEnvelope = { ...envelope, [Symbol("extra")]: true };
  const proxiedBytes = new Proxy(new Uint8Array(envelope.jsonBytes), {});
  const cases = [
    { ...envelope, extra: true },
    symbolEnvelope,
    Object.assign(Object.create(null), envelope),
    { ...envelope, jsonBytes: Buffer.alloc(2_000_001) },
    { ...envelope, jsonBytes: "not-bytes" },
    { ...envelope, signatureText: `${envelope.signatureText}\n` },
    { ...envelope, signatureText: "AB==" },
    accessorEnvelope,
    { ...envelope, jsonBytes: proxiedBytes },
  ];
  for (const cachedEnvelope of cases) {
    const provider = createCachedCatalogProvider(providerOptions({
      cache: { readEnvelope: async () => cachedEnvelope, replaceEnvelope: async () => {} },
    }));
    await assert.rejects(provider.getCurrent(), /catalog_cache_envelope_invalid/u);
  }
  assert.equal(providerAccessorReads, 0);
});

test("getCurrent clones a valid Uint8Array cache view before trust verification", async () => {
  const envelope = signedFixture();
  const aliasedBytes = new Uint8Array(envelope.jsonBytes);
  const provider = createCachedCatalogProvider(providerOptions({
    cache: {
      readEnvelope: async () => ({ ...envelope, jsonBytes: aliasedBytes }),
      replaceEnvelope: async () => {},
    },
  }));

  const service = await provider.getCurrent();
  aliasedBytes.fill(0);

  assert.equal(service.getComponent("chatgpt").version, "1.2.3");
});

test("getCurrent maps every hostile nested byte trap to catalog_cache_envelope_invalid", async () => {
  const envelope = signedFixture();
  class HostileValueBytes extends Uint8Array {
    valueOf() { throw new Error("nested_valueof_trap"); }
  }
  const byteCases = [
    new Proxy(new Uint8Array(envelope.jsonBytes), {
      getPrototypeOf() { throw new Error("nested_getprototypeof_trap"); },
    }),
    new Proxy(new Uint8Array(envelope.jsonBytes), {}),
    new HostileValueBytes(envelope.jsonBytes),
  ];
  for (const jsonBytes of byteCases) {
    const provider = createCachedCatalogProvider(providerOptions({
      cache: {
        readEnvelope: async () => ({ ...envelope, jsonBytes }),
        replaceEnvelope: async () => {},
      },
    }));
    await assert.rejects(provider.getCurrent(), (error) => error?.code === "catalog_cache_envelope_invalid");
  }
});

test("getCurrent clones a typed-array subclass without invoking its hostile species", async () => {
  const envelope = signedFixture();
  let speciesReads = 0;
  class HostileSpeciesBytes extends Uint8Array {
    static get [Symbol.species]() {
      speciesReads += 1;
      throw new Error("nested_species_trap");
    }
  }
  const provider = createCachedCatalogProvider(providerOptions({
    cache: {
      readEnvelope: async () => ({ ...envelope, jsonBytes: new HostileSpeciesBytes(envelope.jsonBytes) }),
      replaceEnvelope: async () => {},
    },
  }));

  assert.equal((await provider.getCurrent()).getComponent("chatgpt").version, "1.2.3");
  assert.equal(speciesReads, 0);
});

test("refresh fetches only exact URLs with redirects disabled and caches only verified bytes", async () => {
  const envelope = signedFixture("2.0.0");
  const calls = [];
  const store = memoryCacheStore();
  const provider = createCachedCatalogProvider(providerOptions({
    cache: createCatalogCache({ cacheStore: store }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === TEST_CATALOG_URL) return response(envelope.jsonBytes);
      if (url === TEST_SIGNATURE_URL) return response(envelope.signatureText);
      throw new Error("unexpected_url");
    },
  }));

  const service = await provider.refresh();

  assert.equal(service.getComponent("chatgpt").version, "2.0.0");
  assert.deepEqual(calls.map(({ url }) => url), [TEST_CATALOG_URL, TEST_SIGNATURE_URL]);
  assert.equal(calls.every(({ options }) => options.redirect === "error" && options.signal instanceof AbortSignal), true);
  assert.equal(store.replacements.length, 1);
});

test("refresh rejects a signed rollback before replacing the bundled or newer cached baseline", async (t) => {
  for (const scenario of [
    { name: "first run", bundled: "4.5.6", cached: null, remote: "4.5.5", expected: "4.5.6" },
    { name: "stale cache", bundled: "4.5.6", cached: "4.5.4", remote: "4.5.5", expected: "4.5.6" },
    { name: "newer cache and remote below bundled", bundled: "4.5.6", cached: "6.0.0", remote: "4.5.5", expected: "6.0.0" },
    { name: "newer cache and remote above bundled", bundled: "4.5.6", cached: "6.0.0", remote: "5.0.0", expected: "6.0.0" },
    { name: "cache without bundled catalog", bundled: null, cached: "6.0.0", remote: "5.0.0", expected: "6.0.0" },
  ]) {
    await t.test(scenario.name, async () => {
      const store = memoryCacheStore();
      const cache = createCatalogCache({ cacheStore: store });
      if (scenario.cached) await cache.replaceEnvelope(signedFixture(scenario.cached));
      const priorRecord = store.snapshot();
      const priorWrites = store.replacements.length;
      const incoming = signedFixture(scenario.remote);
      const provider = createCachedCatalogProvider(providerOptions({
        bundledEnvelope: scenario.bundled ? signedFixture(scenario.bundled) : null,
        cache,
        fetchImpl: async (url) => response(url === TEST_CATALOG_URL ? incoming.jsonBytes : incoming.signatureText),
      }));

      assert.equal((await provider.getCurrent()).getComponent("chatgpt").version, scenario.expected);
      await assert.rejects(provider.refresh(), (error) => error?.code === "catalog_version_rollback");
      assert.equal(store.replacements.length, priorWrites);
      assert.deepEqual(store.snapshot(), priorRecord);
      assert.equal((await provider.getCurrent()).getComponent("chatgpt").version, scenario.expected);
    });
  }
});

test("refresh applies the baseline to missing components and downgraded or missing Skills", async (t) => {
  const skill = {
    id: "documents", name: "Documents", description: "Document tools", version: "2.0.0",
    assetUrl: "https://shanhaiyouling.com/codexbridge-test/packages/documents-2.0.0.zip",
    size: 100, sha256: "b".repeat(64), files: ["SKILL.md"],
  };
  const bundledEnvelope = signedFixture("4.5.6", { skills: [skill] });
  for (const scenario of [
    { name: "component missing", overrides: { components: [], skills: [skill] } },
    { name: "Skill missing", overrides: { skills: [] } },
    { name: "Skill downgraded", overrides: { skills: [{ ...skill, version: "1.0.0" }] } },
  ]) {
    await t.test(scenario.name, async () => {
      const incoming = signedFixture("5.0.0", scenario.overrides);
      const store = memoryCacheStore();
      const provider = createCachedCatalogProvider(providerOptions({
        bundledEnvelope,
        cache: createCatalogCache({ cacheStore: store }),
        fetchImpl: async (url) => response(url === TEST_CATALOG_URL ? incoming.jsonBytes : incoming.signatureText),
      }));

      await assert.rejects(provider.refresh(), (error) => error?.code === "catalog_version_rollback");
      assert.equal(store.snapshot(), null);
      assert.equal((await provider.getCurrent()).getSkill("documents").version, "2.0.0");
    });
  }
});

test("refresh accepts equal numeric versions and monotonic upgrades", async () => {
  let incoming;
  const store = memoryCacheStore();
  const cache = createCatalogCache({ cacheStore: store });
  const provider = createCachedCatalogProvider(providerOptions({
    bundledEnvelope: signedFixture("4.5.6"),
    cache,
    fetchImpl: async (url) => response(url === TEST_CATALOG_URL ? incoming.jsonBytes : incoming.signatureText),
  }));

  for (const version of ["4.5.6", "4.5.6.0", "4.5.7", "5.0.0"]) {
    incoming = signedFixture(version);
    const refreshed = await provider.refresh();
    assert.equal(refreshed.getComponent("chatgpt").version, version);
    assert.equal(provider.describe(refreshed).source, "remote");
    assert.equal((await provider.getCurrent()).getComponent("chatgpt").version, version);
    assert.deepEqual(await cache.readEnvelope(), incoming);
  }
  assert.equal(store.replacements.length, 4);
});

test("a cache failure cannot erase a catalog version already verified in this process", async (t) => {
  for (const mode of ["missing", "read error", "invalid signature", "older valid cache"]) {
    await t.test(mode, async () => {
      const current = signedFixture("6.0.0");
      const older = signedFixture("5.0.0");
      let degraded = false;
      let writes = 0;
      const provider = createCachedCatalogProvider(providerOptions({
        bundledEnvelope: signedFixture("4.0.0"),
        cache: {
          async readEnvelope() {
            if (!degraded) return current;
            if (mode === "missing") return null;
            if (mode === "read error") throw new Error("transient_cache_read_failure");
            if (mode === "invalid signature") return { ...older, signatureText: Buffer.alloc(256).toString("base64") };
            return older;
          },
          async replaceEnvelope() { writes += 1; },
        },
        fetchImpl: async (url) => response(url === TEST_CATALOG_URL ? older.jsonBytes : older.signatureText),
      }));
      assert.equal((await provider.getCurrent()).getComponent("chatgpt").version, "6.0.0");
      degraded = true;
      await assert.rejects(provider.refresh(), { code: "catalog_version_rollback" });
      assert.equal(writes, 0);
      assert.equal((await provider.getCurrent()).getComponent("chatgpt").version, "6.0.0");
    });
  }
});

test("a successfully refreshed catalog remains the installation baseline if its cache becomes unreadable", async () => {
  let incoming = completeSignedFixture("6.0.0");
  let cached = null;
  let cacheFailed = false;
  let writes = 0;
  const preparedTargets = [];
  const provider = createCachedCatalogProvider(providerOptions({
    bundledEnvelope: completeSignedFixture("4.0.0"),
    cache: {
      async readEnvelope() {
        if (cacheFailed) throw new Error("cache_locked");
        return cached;
      },
      async replaceEnvelope(envelope) { cached = envelope; writes += 1; },
    },
    fetchImpl: async (url) => response(url === TEST_CATALOG_URL ? incoming.jsonBytes : incoming.signatureText),
  }));
  const service = installationProbeService(provider, preparedTargets);
  await service.getSnapshot();
  assert.equal((await service.refresh()).components.find((item) => item.id === "chatgpt").version, "6.0.0");
  cacheFailed = true;
  incoming = completeSignedFixture("5.0.0");
  const after = await service.refresh();
  assert.equal(after.readOnly, false);
  assert.equal(after.catalog.refreshError, "catalog_version_rollback");
  assert.equal(after.components.find((item) => item.id === "chatgpt").version, "6.0.0");
  await service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  assert.deepEqual(preparedTargets.map((item) => item.version), ["6.0.0"]);
  assert.equal(writes, 1);
});

test("a late cache read cannot lower a more recently accepted remote catalog", async () => {
  const older = signedFixture("6.0.0");
  const newer = signedFixture("7.0.0");
  let releaseRead;
  const delayedRead = new Promise((resolve) => { releaseRead = resolve; });
  let reads = 0;
  let cached = older;
  const provider = createCachedCatalogProvider(providerOptions({
    bundledEnvelope: signedFixture("4.0.0"),
    cache: {
      readEnvelope() { return ++reads === 1 ? delayedRead : Promise.resolve(cached); },
      async replaceEnvelope(envelope) { cached = envelope; },
    },
    fetchImpl: async (url) => response(url === TEST_CATALOG_URL ? newer.jsonBytes : newer.signatureText),
  }));
  const pending = provider.getCurrent();
  assert.equal((await provider.refresh()).getComponent("chatgpt").version, "7.0.0");
  releaseRead(older);
  assert.equal((await pending).getComponent("chatgpt").version, "7.0.0");
});

test("a failed cache replacement does not advance the accepted in-memory version", async () => {
  let cached = signedFixture("6.0.0");
  let incoming = signedFixture("7.0.0");
  let failWrite = true;
  const writeError = new Error("cache_write_failed");
  const provider = createCachedCatalogProvider(providerOptions({
    bundledEnvelope: signedFixture("4.0.0"),
    cache: {
      async readEnvelope() { return cached; },
      async replaceEnvelope(envelope) {
        if (failWrite) throw writeError;
        cached = envelope;
      },
    },
    fetchImpl: async (url) => response(url === TEST_CATALOG_URL ? incoming.jsonBytes : incoming.signatureText),
  }));
  assert.equal((await provider.getCurrent()).getComponent("chatgpt").version, "6.0.0");
  await assert.rejects(provider.refresh(), (error) => error === writeError);
  assert.equal((await provider.getCurrent()).getComponent("chatgpt").version, "6.0.0");
  failWrite = false;
  incoming = signedFixture("6.5.0");
  assert.equal((await provider.refresh()).getComponent("chatgpt").version, "6.5.0");
});

test("a verified refresh can repair an untrusted cache without trusting its version", async (t) => {
  for (const bundledEnvelope of [null, signedFixture("4.5.6")]) {
    await t.test(bundledEnvelope ? "with bundled baseline" : "without bundled baseline", async () => {
      const invalid = signedFixture("99.0.0");
      const store = memoryCacheStore({
        catalogUrl: invalid.catalogUrl,
        jsonBase64: invalid.jsonBytes.toString("base64"),
        signatureText: Buffer.alloc(256).toString("base64"),
      });
      const incoming = signedFixture("5.0.0");
      const cache = createCatalogCache({ cacheStore: store });
      const provider = createCachedCatalogProvider(providerOptions({
        bundledEnvelope,
        cache,
        fetchImpl: async (url) => response(url === TEST_CATALOG_URL ? incoming.jsonBytes : incoming.signatureText),
      }));

      assert.equal((await provider.refresh()).getComponent("chatgpt").version, "5.0.0");
      assert.deepEqual(await cache.readEnvelope(), incoming);
      assert.equal(store.replacements.length, 1);
    });
  }
});

test("a signed malformed refresh cannot replace a valid catalog above the baseline", async () => {
  const current = signedFixture("5.0.0");
  const store = memoryCacheStore();
  const cache = createCatalogCache({ cacheStore: store });
  await cache.replaceEnvelope(current);
  const incoming = signedFixture("6.0.0", { schemaVersion: 2 });
  const provider = createCachedCatalogProvider(providerOptions({
    bundledEnvelope: signedFixture("4.5.6"),
    cache,
    fetchImpl: async (url) => response(url === TEST_CATALOG_URL ? incoming.jsonBytes : incoming.signatureText),
  }));

  await assert.rejects(provider.refresh(), (error) => error?.code === "catalog_schema_invalid");
  assert.deepEqual(await cache.readEnvelope(), current);
  assert.equal(store.replacements.length, 1);
});

test("a rejected refresh leaves the real software service writable and prepares the current installation asset", async (t) => {
  for (const scenario of [
    { name: "bundled", cached: null, remote: "26.814.5516.0", expected: "26.814.5517.0" },
    { name: "newer cache", cached: "26.814.5518.0", remote: "26.814.5517.0", expected: "26.814.5518.0" },
  ]) {
    await t.test(scenario.name, async () => {
      const store = memoryCacheStore();
      const cache = createCatalogCache({ cacheStore: store });
      if (scenario.cached) await cache.replaceEnvelope(completeSignedFixture(scenario.cached));
      const priorRecord = store.snapshot();
      let incoming = completeSignedFixture(scenario.remote);
      const provider = createCachedCatalogProvider(providerOptions({
        bundledEnvelope: completeSignedFixture("26.814.5517.0"),
        cache,
        fetchImpl: async (url) => response(url === TEST_CATALOG_URL ? incoming.jsonBytes : incoming.signatureText),
      }));
      const preparedTargets = [];
      const service = installationProbeService(provider, preparedTargets);

      assert.equal((await service.getSnapshot()).components[0].version, scenario.expected);
      const refreshed = await service.refresh();
      assert.equal(refreshed.catalog.refreshError, "catalog_version_rollback");
      assert.equal(refreshed.catalog.source, scenario.cached ? "cache" : "bundled");
      assert.equal(refreshed.readOnly, false);
      assert.equal(refreshed.catalog.available, true);
      assert.equal(refreshed.components[0].version, scenario.expected);
      assert.equal((await service.getSnapshot()).components[0].version, scenario.expected);
      for (const kind of ["install", "update"]) {
        const result = await service.startTask({ kind, componentIds: ["chatgpt"], skillIds: [] });
        assert.equal(result.status, "succeeded");
        assert.equal(result.components[0].versionAfter, scenario.expected);
      }
      assert.deepEqual(preparedTargets, ["install", "update"].map(() => ({
        id: "chatgpt",
        version: scenario.expected,
        assetUrl: `https://shanhaiyouling.com/codexbridge-test/packages/chatgpt-${scenario.expected}.zip`,
      })));
      assert.deepEqual(store.snapshot(), priorRecord);

      const installedService = installationProbeService(provider, preparedTargets, scenario.expected);
      await installedService.refresh();
      const current = await installedService.startTask({ kind: "update", componentIds: ["chatgpt"], skillIds: [] });
      assert.equal(current.components[0].status, "skipped");
      assert.equal(current.components[0].message, "software_manager_already_current");
      assert.equal(preparedTargets.length, 2);

      incoming = completeSignedFixture(scenario.expected);
      const recovered = await service.refresh();
      assert.equal(recovered.catalog.refreshError, null);
      assert.equal(recovered.catalog.source, "remote");
      assert.equal(recovered.components[0].version, scenario.expected);
      assert.equal(recovered.readOnly, false);
      assert.deepEqual(await cache.readEnvelope(), incoming);
    });
  }
});

test("overlapping refresh calls are one single-flight promise and one committed fetch pair", async () => {
  const envelope = signedFixture("3.0.0");
  let releaseCatalog;
  const catalogGate = new Promise((resolve) => { releaseCatalog = resolve; });
  const calls = [];
  const store = memoryCacheStore();
  const provider = createCachedCatalogProvider(providerOptions({
    cache: createCatalogCache({ cacheStore: store }),
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === TEST_CATALOG_URL) {
        await catalogGate;
        return response(envelope.jsonBytes);
      }
      return response(envelope.signatureText);
    },
  }));

  const first = provider.refresh();
  const second = provider.refresh();
  const samePromise = first === second;
  releaseCatalog();
  const [firstService, secondService] = await Promise.all([first, second]);

  assert.equal(samePromise, true);
  assert.equal(firstService, secondService);
  assert.deepEqual(calls, [TEST_CATALOG_URL, TEST_SIGNATURE_URL]);
  assert.equal(store.replacements.length, 1);
});

test("a synchronously reentrant fetch wrapper cannot start a second refresh flight", async () => {
  const envelope = signedFixture("3.1.0");
  const calls = [];
  const store = memoryCacheStore();
  let provider;
  let reentrantPromise;
  let didReenter = false;
  provider = createCachedCatalogProvider(providerOptions({
    cache: createCatalogCache({ cacheStore: store }),
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === TEST_CATALOG_URL && !didReenter) {
        didReenter = true;
        reentrantPromise = provider.refresh();
      }
      return url === TEST_CATALOG_URL ? response(envelope.jsonBytes) : response(envelope.signatureText);
    },
  }));

  const outerPromise = provider.refresh();
  const service = await outerPromise;

  assert.equal(reentrantPromise, outerPromise);
  assert.equal(service.getComponent("chatgpt").version, "3.1.0");
  assert.deepEqual(calls, [TEST_CATALOG_URL, TEST_SIGNATURE_URL]);
  assert.equal(store.replacements.length, 1);
});

test("a failed single-flight refresh releases its promise so a later refresh can retry", async () => {
  const envelope = signedFixture("4.0.0");
  let catalogAttempts = 0;
  const store = memoryCacheStore();
  const provider = createCachedCatalogProvider(providerOptions({
    cache: createCatalogCache({ cacheStore: store }),
    fetchImpl: async (url) => {
      if (url === TEST_CATALOG_URL && catalogAttempts++ === 0) throw new Error("first_fetch_failed");
      return url === TEST_CATALOG_URL ? response(envelope.jsonBytes) : response(envelope.signatureText);
    },
  }));

  const failed = provider.refresh();
  const joinedFailure = provider.refresh();
  assert.equal(joinedFailure, failed);
  await assert.rejects(failed, /first_fetch_failed/u);
  const retry = provider.refresh();

  assert.notEqual(retry, failed);
  assert.equal((await retry).getComponent("chatgpt").version, "4.0.0");
  assert.equal(catalogAttempts, 2);
  assert.equal(store.replacements.length, 1);
});

test("refresh strictly decodes signature text and stores one compact canonical base64 value", async () => {
  const envelope = signedFixture();
  const store = memoryCacheStore();
  const provider = createCachedCatalogProvider(providerOptions({
    cache: createCatalogCache({ cacheStore: store }),
    fetchImpl: async (url) => url === TEST_CATALOG_URL
      ? response(envelope.jsonBytes)
      : response(Buffer.from(`\uFEFF ${envelope.signatureText.slice(0, 80)}\r\n${envelope.signatureText.slice(80)}\t`, "utf8")),
  }));

  await provider.refresh();

  assert.equal(store.snapshot().signatureText, envelope.signatureText);
});

test("refresh rejects malformed UTF-8 and non-ASCII signature whitespace before verification", async () => {
  const envelope = signedFixture();
  for (const signatureBytes of [
    Buffer.from([0xc3, 0x28]),
    Buffer.from(`${envelope.signatureText.slice(0, 80)}\u00A0${envelope.signatureText.slice(80)}`, "utf8"),
    Buffer.from("AB==", "utf8"),
  ]) {
    let writes = 0;
    const provider = createCachedCatalogProvider(providerOptions({
      cache: { readEnvelope: async () => null, replaceEnvelope: async () => { writes += 1; } },
      fetchImpl: async (url) => url === TEST_CATALOG_URL ? response(envelope.jsonBytes) : response(signatureBytes),
    }));
    await assert.rejects(provider.refresh(), /catalog_signature_text_invalid/u);
    assert.equal(writes, 0);
  }
});

test("refresh rejects non-success responses without replacing the prior cache", async () => {
  const prior = signedFixture();
  const priorRecord = {
    catalogUrl: prior.catalogUrl,
    jsonBase64: prior.jsonBytes.toString("base64"),
    signatureText: prior.signatureText,
  };
  const store = memoryCacheStore(priorRecord);
  const provider = createCachedCatalogProvider(providerOptions({
    cache: createCatalogCache({ cacheStore: store }),
    fetchImpl: async () => response("no", { status: 503 }),
  }));

  await assert.rejects(provider.refresh(), /catalog_fetch_status/u);
  assert.deepEqual(store.snapshot(), priorRecord);
  assert.equal(store.replacements.length, 0);
});

test("refresh cancels an over-limit response stream before reading further chunks", async () => {
  const streamed = trackedStream([Buffer.alloc(5), Buffer.alloc(5), Buffer.alloc(5)]);
  const writes = [];
  const provider = createCachedCatalogProvider(providerOptions({
    maxCatalogBytes: 8,
    cache: { readEnvelope: async () => null, replaceEnvelope: async (value) => { writes.push(value); } },
    fetchImpl: async () => response(streamed.body),
  }));

  await assert.rejects(provider.refresh(), /catalog_response_too_large/u);
  assert.equal(streamed.state.cancelled, true);
  assert.deepEqual(writes, []);
});

test("an uncooperative response cancel cannot hold an over-limit rejection open", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.alloc(9));
      controller.enqueue(Buffer.alloc(1));
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  });
  const provider = createCachedCatalogProvider(providerOptions({
    maxCatalogBytes: 8,
    fetchImpl: async () => response(body),
  }));

  const outcome = await Promise.race([
    provider.refresh().then(() => "resolved", (error) => error.code),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 50)),
  ]);

  assert.equal(cancelled, true);
  assert.equal(outcome, "catalog_response_too_large");
});

test("refresh enforces the signature response byte limit", async () => {
  const envelope = signedFixture();
  const signatureStream = trackedStream([Buffer.alloc(9), Buffer.alloc(1), Buffer.alloc(1)]);
  const provider = createCachedCatalogProvider(providerOptions({
    maxSignatureBytes: 8,
    fetchImpl: async (url) => url === TEST_CATALOG_URL
      ? response(envelope.jsonBytes)
      : response(signatureStream.body),
  }));

  await assert.rejects(provider.refresh(), /catalog_response_too_large/u);
  assert.equal(signatureStream.state.cancelled, true);
});

test("refresh aborts and rejects a fetch that exceeds its deadline", async () => {
  let observedSignal;
  const provider = createCachedCatalogProvider(providerOptions({
    timeoutMs: 10,
    fetchImpl: async (_url, { signal }) => {
      observedSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  }));

  await assert.rejects(provider.refresh(), /catalog_fetch_timeout/u);
  assert.equal(observedSignal.aborted, true);
});

test("refresh bounds the baseline cache read and never commits after its deadline", async () => {
  const incoming = signedFixture("5.0.0");
  let releaseCache;
  let writes = 0;
  const provider = createCachedCatalogProvider(providerOptions({
    bundledEnvelope: signedFixture("4.5.6"),
    timeoutMs: 10,
    cache: {
      readEnvelope: () => new Promise((resolve) => { releaseCache = resolve; }),
      replaceEnvelope: async () => { writes += 1; },
    },
    fetchImpl: async (url) => response(url === TEST_CATALOG_URL ? incoming.jsonBytes : incoming.signatureText),
  }));

  const refresh = provider.refresh();
  const outcome = await Promise.race([
    refresh.then(() => "resolved", (error) => error.code),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 100)),
  ]);
  releaseCache(null);
  await refresh.catch(() => {});

  assert.equal(outcome, "catalog_fetch_timeout");
  assert.equal(writes, 0);
});

test("a response arriving after the catalog deadline is cancelled instead of leaked", async () => {
  let resolveFetch;
  let cancelled = false;
  const lateBody = new ReadableStream({
    pull() {},
    cancel() {
      cancelled = true;
    },
  });
  const provider = createCachedCatalogProvider(providerOptions({
    timeoutMs: 10,
    fetchImpl: async () => new Promise((resolve) => { resolveFetch = resolve; }),
  }));

  await assert.rejects(provider.refresh(), /catalog_fetch_timeout/u);
  resolveFetch(response(lateBody));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test("a failed signature verification preserves and continues serving the last valid cache", async () => {
  const prior = signedFixture("1.0.0");
  const incoming = signedFixture("2.0.0");
  const store = memoryCacheStore({
    catalogUrl: prior.catalogUrl,
    jsonBase64: prior.jsonBytes.toString("base64"),
    signatureText: prior.signatureText,
  });
  const provider = createCachedCatalogProvider(providerOptions({
    cache: createCatalogCache({ cacheStore: store }),
    fetchImpl: async (url) => url === TEST_CATALOG_URL
      ? response(incoming.jsonBytes)
      : response(prior.signatureText),
  }));

  await assert.rejects(provider.refresh(), /catalog_signature_invalid/u);
  assert.equal(store.replacements.length, 0);
  assert.equal((await provider.getCurrent()).getComponent("chatgpt").version, "1.0.0");
});

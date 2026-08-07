import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { createCatalogCache } from "../desktop/software-manager/catalog-cache.mjs";
import { createCachedCatalogProvider } from "../desktop/software-manager/catalog-provider.mjs";

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

function signedFixture(version = "1.2.3") {
  const jsonBytes = Buffer.from(JSON.stringify(catalogFixture(version)));
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

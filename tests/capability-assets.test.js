import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveCapabilityAssetResult } from "../src/capability-assets.js";

test("capability asset saving keeps large visual outputs local without inline base64", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-capability-assets-"));
  const largePng = Buffer.concat([
    Buffer.from("iVBORw0KGgo=", "base64"),
    Buffer.alloc(768 * 1024, 7),
  ]);

  const result = await saveCapabilityAssetResult({
    capability: "webpage_screenshot",
    outputDir,
    upstream: {
      imageBase64: largePng.toString("base64"),
    },
  });

  assert.equal(result.capability, "webpage_screenshot");
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.bytes, largePng.length);
  assert.equal(result.base64, undefined);
  assert.match(result.localPath, /webpage_screenshot/);
  assert.equal(fs.existsSync(result.localPath), true);
  assert.equal(fs.statSync(result.localPath).size, largePng.length);
});

test("capability asset saving rejects oversized downloads before reading the body", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-capability-assets-large-"));
  let arrayBufferCalled = false;

  await assert.rejects(
    () => saveCapabilityAssetResult({
      capability: "webpage_screenshot",
      outputDir,
      provider: {
        id: "large-asset-provider",
        maxAssetBytes: 1024,
      },
      upstream: {
        imageUrl: "https://assets.example/large.png",
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({
          "content-length": "2048",
          "content-type": "image/png",
        }),
        async arrayBuffer() {
          arrayBufferCalled = true;
          return Buffer.from("should not be read").buffer;
        },
      }),
    }),
    (error) => {
      assert.equal(error.code, "asset_too_large");
      assert.match(error.message, /2048 bytes/);
      return true;
    },
  );

  assert.equal(arrayBufferCalled, false);
});

test("capability asset saving reports failed downloads in Chinese", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-capability-assets-download-fail-"));

  await assert.rejects(
    () => saveCapabilityAssetResult({
      capability: "webpage_screenshot",
      outputDir,
      upstream: {
        imageUrl: "https://assets.example/expired.png",
      },
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        headers: new Headers({ "content-type": "application/json" }),
        async arrayBuffer() {
          return Buffer.from("forbidden").buffer;
        },
      }),
    }),
    (error) => {
      assert.equal(error.code, "asset_download_failed");
      assert.equal(error.statusCode, 403);
      assert.match(error.message, /能力结果下载失败：HTTP 403/);
      assert.doesNotMatch(error.message, /Capability result download failed/);
      return true;
    },
  );
});

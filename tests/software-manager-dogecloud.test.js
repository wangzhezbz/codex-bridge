import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDogeCloudArtifactPublisher,
  DOGECLOUD_PACKAGE_BASE_URL,
} from "../scripts/software-manager/dogecloud-artifact-publisher.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-dogecloud-"));
  const packagePath = path.join(root, "package.bin");
  fs.writeFileSync(packagePath, "verified-package-bytes");
  const size = fs.statSync(packagePath).size;
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(packagePath)).digest("hex");
  return { root, packagePath, size, sha256 };
}

test("DogeCloud publisher runs an isolated uploader without placing permanent secrets in argv", async () => {
  const value = fixture();
  const helper = path.join(value.root, "uploader.mjs");
  fs.writeFileSync(helper, `
    const values = Object.fromEntries(process.argv.slice(2).map((value, index, all) => index % 2 === 0 ? [value, all[index + 1]] : null).filter(Boolean));
    if (!process.env.CBI_DOGECLOUD_ACCESS_KEY || !process.env.CBI_DOGECLOUD_SECRET_KEY) process.exit(12);
    process.stdout.write(JSON.stringify({ action: "uploaded", objectKey: values["--object-key"], size: Number(values["--expected-size"]), sha256: values["--expected-sha256"] }));
  `);
  const publisher = createDogeCloudArtifactPublisher({
    packageBaseUrl: DOGECLOUD_PACKAGE_BASE_URL,
    env: {
      CBI_DOGECLOUD_ACCESS_KEY: "access-for-test",
      CBI_DOGECLOUD_SECRET_KEY: "secret-for-test",
      CBI_DOGECLOUD_BUCKET: "codex",
      CBI_DOGECLOUD_UPLOADER: helper,
      CBI_DOGECLOUD_PYTHON: process.execPath,
    },
  });
  const result = await publisher.publish({
    sourcePath: value.packagePath,
    relativePath: "skills/documents-1.0.0.zip",
    expectedSize: value.size,
    expectedSha256: value.sha256,
  });
  assert.deepEqual(result, {
    action: "uploaded",
    objectKey: "codexbridge-test/packages/skills/documents-1.0.0.zip",
    size: value.size,
    sha256: value.sha256,
    url: `${DOGECLOUD_PACKAGE_BASE_URL}skills/documents-1.0.0.zip`,
  });
});

test("DogeCloud publisher rejects traversal, missing credentials and unverified uploader output", async () => {
  const value = fixture();
  assert.throws(() => createDogeCloudArtifactPublisher({
    packageBaseUrl: DOGECLOUD_PACKAGE_BASE_URL,
    env: {},
  }), /dogecloud_credentials_required/);
  const helper = path.join(value.root, "bad-uploader.mjs");
  fs.writeFileSync(helper, 'process.stdout.write(JSON.stringify({ action: "uploaded", objectKey: "wrong", size: 1, sha256: "0".repeat(64) }));');
  const publisher = createDogeCloudArtifactPublisher({
    packageBaseUrl: DOGECLOUD_PACKAGE_BASE_URL,
    env: {
      CBI_DOGECLOUD_ACCESS_KEY: "access-for-test",
      CBI_DOGECLOUD_SECRET_KEY: "secret-for-test",
      CBI_DOGECLOUD_BUCKET: "codex",
      CBI_DOGECLOUD_UPLOADER: helper,
      CBI_DOGECLOUD_PYTHON: process.execPath,
    },
  });
  await assert.rejects(publisher.publish({
    sourcePath: value.packagePath,
    relativePath: "../escape.zip",
    expectedSize: value.size,
    expectedSha256: value.sha256,
  }), /dogecloud_relative_path_rejected/);
  await assert.rejects(publisher.publish({
    sourcePath: value.packagePath,
    relativePath: "chatgpt.zip",
    expectedSize: value.size,
    expectedSha256: value.sha256,
  }), /dogecloud_upload_result_invalid/);
});

test("non-DogeCloud package origins keep the existing local publisher behavior", async () => {
  const value = fixture();
  const publisher = createDogeCloudArtifactPublisher({
    packageBaseUrl: "https://shanhaiyouling.com/codexbridge-test/packages/",
    env: {},
  });
  assert.deepEqual(await publisher.publish({
    sourcePath: value.packagePath,
    relativePath: "chatgpt.zip",
    expectedSize: value.size,
    expectedSha256: value.sha256,
  }), {
    action: "local",
    objectKey: null,
    size: value.size,
    sha256: value.sha256,
    url: "https://shanhaiyouling.com/codexbridge-test/packages/chatgpt.zip",
  });
});

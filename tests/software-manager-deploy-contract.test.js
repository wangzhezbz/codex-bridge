import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { verifyTestEndpoint } from "../deploy/codexbridge-installer/verify-test.mjs";

const deployRoot = path.join(process.cwd(), "deploy", "codexbridge-installer");
const names = [
  "README.md",
  "nginx-test-location.conf",
  "codexbridge-installer-sync.service",
  "codexbridge-installer-sync.timer",
  "install-test.sh",
  "verify-test.mjs",
];

function deployFiles() {
  return names.map((name) => path.join(deployRoot, name));
}

test("isolated deployment assets are complete", () => {
  for (const file of deployFiles()) assert.equal(fs.existsSync(file), true, file);
});

test("deployment assets cannot target old installer trees or future production locations", () => {
  for (const file of deployFiles()) {
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(text, /\/opt\/shanhai\/codex-installer(?:\/|\b)/u, file);
    assert.doesNotMatch(text, /location\s+(?:=\s+)?\/install(?:-test)?\//u, file);
    assert.doesNotMatch(text, /\/codexbridge-install\//u, file);
  }
});

test("deployment uses only the new root, test catalog path and immutable package prefix", () => {
  const combined = deployFiles().map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.match(combined, /\/opt\/shanhai\/codexbridge-installer\//u);
  assert.match(combined, /\/codexbridge-install-test\//u);
  assert.match(combined, /\/codexbridge-test\/packages\//u);
  assert.doesNotMatch(combined, /codex-release\.json|OpenAI\.Codex_/u);
});

test("private signing key remains root-only and only public SPKI plus fingerprint are printed", () => {
  const installer = fs.readFileSync(path.join(deployRoot, "install-test.sh"), "utf8");
  const service = fs.readFileSync(path.join(deployRoot, "codexbridge-installer-sync.service"), "utf8");
  assert.match(installer, /umask 077/u);
  assert.match(installer, /chmod 0600 "\$PRIVATE_KEY"/u);
  assert.match(installer, /openssl genpkey/u);
  assert.match(installer, /openssl pkey[^\n]+-pubout/u);
  assert.match(installer, /sha256/u);
  assert.doesNotMatch(installer, /cat "\$PRIVATE_KEY"/u);
  assert.match(service, /^User=root$/mu);
  assert.match(service, /ProtectSystem=strict/u);
  assert.match(service, /ReadWritePaths=\/opt\/shanhai\/codexbridge-installer\//u);
});

test("nginx prevents catalog caching and gives immutable packages a long cache", () => {
  const nginx = fs.readFileSync(path.join(deployRoot, "nginx-test-location.conf"), "utf8");
  assert.match(nginx, /location = \/codexbridge-install-test\/component-catalog\.json/u);
  assert.match(nginx, /location = \/codexbridge-install-test\/component-catalog\.json\.sig/u);
  assert.equal((nginx.match(/Cache-Control "no-store"/gu) || []).length, 2);
  assert.match(nginx, /location \/codexbridge-test\/packages\//u);
  assert.match(nginx, /Cache-Control "public, max-age=31536000, immutable"/u);
});

test("installer is idempotent, validates nginx before reload and installs only new named units", () => {
  const installer = fs.readFileSync(path.join(deployRoot, "install-test.sh"), "utf8");
  assert.match(installer, /systemctl enable --now codexbridge-installer-sync\.timer/u);
  assert.match(installer, /nginx -t/u);
  assert.match(installer, /systemctl reload nginx/u);
  assert.match(installer, /realpath/u);
  assert.match(installer, /\/opt\/shanhai\/codexbridge-installer/u);
  assert.doesNotMatch(installer, /rm\s+-rf|systemctl\s+(?:stop|disable|restart)\s+codex-(?:installer|license)/u);
});

test("remote verifier is read-only and checks signature, HEAD length and streamed SHA256", () => {
  const verifier = fs.readFileSync(path.join(deployRoot, "verify-test.mjs"), "utf8");
  assert.match(verifier, /verifyCatalogEnvelope/u);
  assert.match(verifier, /method:\s*"HEAD"/u);
  assert.match(verifier, /createHash\("sha256"\)/u);
  assert.match(verifier, /body\.getReader/u);
  assert.match(verifier, /codexbridge-install-test\/component-catalog\.json/u);
  assert.doesNotMatch(verifier, /method:\s*"(?:POST|PUT|PATCH|DELETE)"/u);
});

test("systemd timer is bounded and uses the isolated root-owned environment", () => {
  const service = fs.readFileSync(path.join(deployRoot, "codexbridge-installer-sync.service"), "utf8");
  const timer = fs.readFileSync(path.join(deployRoot, "codexbridge-installer-sync.timer"), "utf8");
  assert.match(service, /EnvironmentFile=\/opt\/shanhai\/codexbridge-installer\/private\/publisher\.env/u);
  assert.match(service, /TimeoutStartSec=30min/u);
  assert.match(timer, /OnCalendar=/u);
  assert.match(timer, /RandomizedDelaySec=/u);
  assert.match(timer, /Persistent=true/u);
});

test("publisher uses the isolated Node runtime instead of changing the server Node installation", () => {
  const installer = fs.readFileSync(path.join(deployRoot, "install-test.sh"), "utf8");
  const service = fs.readFileSync(path.join(deployRoot, "codexbridge-installer-sync.service"), "utf8");
  const readme = fs.readFileSync(path.join(deployRoot, "README.md"), "utf8");
  assert.match(installer, /RUNTIME_BIN="\$ROOT\/runtime\/node\/bin"/u);
  assert.match(installer, /"\$RUNTIME_BIN\/node"/u);
  assert.match(installer, /"\$RUNTIME_BIN\/npm"/u);
  assert.match(installer, /PATH="\$RUNTIME_BIN:\$PATH" "\$RUNTIME_BIN\/npm" --version/u);
  assert.match(installer, /SEVEN_ZIP="\$APP_ROOT\/node_modules\/7zip-bin\/linux\/x64\/7za"/u);
  assert.match(installer, /chmod 0755 "\$SEVEN_ZIP"/u);
  assert.doesNotMatch(installer, /for command in [^\n]*\bnode\b/u);
  assert.match(service, /Environment=PATH=\/opt\/shanhai\/codexbridge-installer\/runtime\/node\/bin:/u);
  assert.match(readme, /runtime\/node/u);
  assert.match(readme, /PATH=\.\.\/runtime\/node\/bin:\$PATH/u);
  assert.match(readme, /不安装或修改系统全局 Node/u);
});

test("remote verifier validates a signed catalog and streams every immutable asset read-only", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const asset = Buffer.from("verified-asset");
  const assetUrl = "https://shanhaiyouling.com/codexbridge-test/packages/skills/documents-1.0.0.zip";
  const catalogBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    components: [],
    skills: [{
      id: "documents",
      name: "Documents",
      description: "Create documents.",
      version: "1.0.0",
      assetUrl,
      size: asset.length,
      sha256: crypto.createHash("sha256").update(asset).digest("hex"),
      files: ["SKILL.md"],
    }],
  })}\n`);
  const signature = crypto.sign("RSA-SHA256", catalogBytes, privateKey).toString("base64");
  const calls = [];
  const result = await verifyTestEndpoint({
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    checkedAt: "2026-08-08T00:00:00.000Z",
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      if (url.endsWith("component-catalog.json")) {
        return { ok: true, arrayBuffer: async () => catalogBytes };
      }
      if (url.endsWith("component-catalog.json.sig")) {
        return { ok: true, text: async () => signature };
      }
      if (options.method === "HEAD") {
        return { ok: true, headers: { get: () => String(asset.length) } };
      }
      let sent = false;
      return {
        ok: true,
        body: { getReader: () => ({ read: async () => sent
          ? { done: true }
          : (sent = true, { done: false, value: asset }) }) },
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.assets[0].sha256, crypto.createHash("sha256").update(asset).digest("hex"));
  assert.equal(calls.some(([, options]) => options.method === "HEAD"), true);
  assert.equal(calls.some(([, options]) => /POST|PUT|PATCH|DELETE/u.test(options.method || "")), false);
});

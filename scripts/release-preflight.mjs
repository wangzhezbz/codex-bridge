import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  buildStartupCheck,
  readCodexResourceSnapshots,
  readCapabilityProviders,
  readImageProviders,
  readRouterConfig,
  releasePreflightCodeReadySummary,
  releasePreflightGateSummary,
} from "../desktop/settings.mjs";
import { probeRouterHealth } from "../desktop/router-health.mjs";

const require = createRequire(import.meta.url);
const { resolveDataRootDir } = require("../desktop/data-dir.cjs");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const rootDir = args.dataDir || resolveDataRootDir({
  appRootDir: repoRoot,
  env: process.env,
  isPackaged: false,
  platform: args.platform || process.platform,
});
const homeDir = args.homeDir || os.homedir();
const config = readRouterConfig(rootDir);
const { codexCliSnapshot, codexPromptInputSnapshot } = readCodexResourceSnapshots({ homeDir });
const routerProbe = await probeReleaseRouterHealth(config);
const releaseAssets = [
  ...args.releaseAssets,
  ...releaseAssetsFromDir(args.releaseDir),
];
const generatedAcceptanceReport = args.writeAcceptanceReport
  ? buildRealAcceptanceReport({
      rootDir,
      routerProbe,
      releaseAssets,
      platform: args.platform || process.platform,
      arch: args.arch || process.arch,
    })
  : null;
if (args.writeAcceptanceReport) {
  writeJsonReport(args.writeAcceptanceReport, generatedAcceptanceReport);
}
const realAcceptanceReport = readJsonReport(args.acceptanceReport, "真实检查报告") || generatedAcceptanceReport;
const acceptanceReport = acceptanceReportMeta({
  acceptanceReportPath: args.acceptanceReport,
  writeAcceptanceReportPath: args.writeAcceptanceReport,
  report: realAcceptanceReport,
  generatedReport: generatedAcceptanceReport,
});
const packagedSmokeReport = readPackagedSmokeReport(args.packagedSmokeReport || defaultPackagedSmokeReportPath());
const check = buildStartupCheck(rootDir, {
  homeDir,
  appVersion: packageJson.version,
  config,
  routerRunning: routerProbe.running,
  lastHealth: routerProbe.running ? routerProbe.health : null,
  platform: args.platform || process.platform,
  arch: args.arch || process.arch,
  releaseAssets: releaseAssets.length ? releaseAssets : null,
  realAcceptanceReport,
  packagedSmokeReport,
  codexCliSnapshot,
  codexPromptInputSnapshot,
});
const failCount = Number(check.summary?.fail || 0);
const warnCount = Number(check.summary?.warn || 0);
const releaseGate = releasePreflightGateSummary(check, { strictWarnings: args.strictWarnings });
const codeReady = releasePreflightCodeReadySummary(check);
const releaseOk = args.codeReady
  ? codeReady.ok
  : Boolean(check.summary?.ok) && (!args.strictWarnings || !warnCount);
const gateReport = gateReportMeta({
  writeGateReportPath: args.writeGateReport,
  releaseGate,
});
const releaseReport = {
  ok: releaseOk,
  releaseGate,
  codeReady,
  ...(acceptanceReport ? { acceptanceReport } : {}),
  ...(gateReport ? { gateReport } : {}),
  dataRoot: rootDir,
  homeDir,
  ...check,
};

if (args.writeGateReport) {
  writeJsonReport(args.writeGateReport, releaseReport);
}

if (args.json) {
  console.log(JSON.stringify(releaseReport, null, 2));
} else {
  printReport(check, {
    rootDir,
    homeDir,
    strictWarnings: args.strictWarnings,
    acceptanceReport,
    gateReport,
    releaseGate,
    codeReady,
    codeReadyMode: args.codeReady,
  });
}

if (args.codeReady) {
  if (!codeReady.ok) {
    process.exitCode = 1;
  }
} else if (failCount > 0 || (args.strictWarnings && warnCount > 0)) {
  process.exitCode = 1;
}

function releaseItemIdsByStatus(items = [], status = "") {
  return (items || [])
    .filter((item) => item?.status === status)
    .map((item) => String(item.id || "").trim())
    .filter(Boolean);
}

function acceptanceReportMeta({
  acceptanceReportPath = "",
  writeAcceptanceReportPath = "",
  report = null,
  generatedReport = null,
} = {}) {
  const readPath = String(acceptanceReportPath || "").trim();
  const writePath = String(writeAcceptanceReportPath || "").trim();
  if (!readPath && !writePath) {
    return null;
  }
  const target = path.resolve(writePath || readPath);
  return {
    path: target,
    written: Boolean(writePath),
    loaded: Boolean(readPath),
    generated: Boolean(generatedReport),
    ok: report?.ok === true,
  };
}

function gateReportMeta({
  writeGateReportPath = "",
  releaseGate = null,
} = {}) {
  const writePath = String(writeGateReportPath || "").trim();
  if (!writePath) {
    return null;
  }
  return {
    path: path.resolve(writePath),
    written: true,
    ok: releaseGate?.ok === true,
  };
}

function parseArgs(values = []) {
  const parsed = {
    arch: "",
    acceptanceReport: "",
    codeReady: false,
    dataDir: "",
    help: false,
    homeDir: "",
    json: false,
    platform: "",
    packagedSmokeReport: "",
    releaseAssets: [],
    releaseDir: "",
    strictWarnings: false,
    writeAcceptanceReport: "",
    writeGateReport: "",
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") {
      parsed.help = true;
    } else if (value === "--json") {
      parsed.json = true;
    } else if (value === "--code-ready") {
      parsed.codeReady = true;
    } else if (value === "--strict-warnings") {
      parsed.strictWarnings = true;
    } else if (value === "--data-dir") {
      parsed.dataDir = requireValue(values, index);
      index += 1;
    } else if (value === "--home-dir") {
      parsed.homeDir = requireValue(values, index);
      index += 1;
    } else if (value === "--platform") {
      parsed.platform = requireValue(values, index);
      index += 1;
    } else if (value === "--arch") {
      parsed.arch = requireValue(values, index);
      index += 1;
    } else if (value === "--acceptance-report") {
      parsed.acceptanceReport = requireValue(values, index);
      index += 1;
    } else if (value === "--release-asset") {
      parsed.releaseAssets.push(requireValue(values, index));
      index += 1;
    } else if (value === "--release-dir") {
      parsed.releaseDir = requireValue(values, index);
      index += 1;
    } else if (value === "--write-acceptance-report") {
      parsed.writeAcceptanceReport = requireValue(values, index);
      index += 1;
    } else if (value === "--write-gate-report") {
      parsed.writeGateReport = requireValue(values, index);
      index += 1;
    } else if (value === "--packaged-smoke-report") {
      parsed.packagedSmokeReport = requireValue(values, index);
      index += 1;
    } else {
      throw new Error(`Unknown release preflight option: ${value}`);
    }
  }
  return parsed;
}

function requireValue(values, index) {
  const next = values[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`Missing value for ${values[index]}`);
  }
  return next;
}

function defaultPackagedSmokeReportPath() {
  return path.join(repoRoot, "release", "packaged-smoke-report.json");
}

function readPackagedSmokeReport(reportPath = "") {
  const target = String(reportPath || "").trim();
  if (!target || !fs.existsSync(target)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    return {
      ok: false,
      error: `打包 smoke 报告读取失败：${error.message || error}`,
      reportPath: target,
    };
  }
}

function readJsonReport(reportPath = "", label = "JSON report") {
  const target = String(reportPath || "").trim();
  if (!target) {
    return null;
  }
  if (!fs.existsSync(target)) {
    return {
      ok: false,
      error: `${label}不存在：${target}`,
      reportPath: target,
    };
  }
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    return {
      ok: false,
      error: `${label}读取失败：${error.message || error}`,
      reportPath: target,
    };
  }
}

function writeJsonReport(reportPath = "", report = {}) {
  const target = String(reportPath || "").trim();
  if (!target) {
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function releaseAssetsFromDir(dirPath) {
  if (!dirPath) {
    return [];
  }
  const resolved = path.resolve(dirPath);
  let entries;
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Unable to read release artifact directory: ${resolved}. ${error.message || error}`);
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = path.join(resolved, entry.name);
      const stat = fs.statSync(filePath);
      return {
        name: entry.name,
        path: filePath,
        size: stat.size,
        headerHex: readFileHeaderHex(filePath, 4),
      };
    });
}

function readFileHeaderHex(filePath, byteCount = 4) {
  const buffer = Buffer.alloc(byteCount);
  let handle;
  try {
    handle = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(handle, buffer, 0, byteCount, 0);
    return buffer.subarray(0, bytesRead).toString("hex");
  } finally {
    if (handle !== undefined) {
      fs.closeSync(handle);
    }
  }
}

function buildRealAcceptanceReport({
  rootDir,
  routerProbe,
  releaseAssets = [],
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const imageProviders = readImageProviders(rootDir)
    .filter((provider) => provider.enabled !== false)
    .filter((provider) => freshPassedTest(provider.lastTest))
    .map((provider) => providerAcceptanceEntry(provider));
  const capabilityProviders = readCapabilityProviders(rootDir)
    .filter((provider) => provider.enabled !== false)
    .filter((provider) => !provider.capabilities?.includes("image_generation"))
    .filter((provider) => freshPassedTest(provider.lastTest))
    .map((provider) => providerAcceptanceEntry(provider));
  const windowsInstaller = windowsInstallerAcceptance(releaseAssets, { platform, arch });
  const router = routerAcceptance(routerProbe);
  const ok = Boolean(
    router.ok &&
      imageProviders.length &&
      capabilityProviders.length &&
      windowsInstaller.ok,
  );
  return {
    ok,
    checkedAt: new Date().toISOString(),
    source: "release-preflight",
    router,
    imageProviders,
    capabilityProviders,
    windowsInstaller,
  };
}

function routerAcceptance(routerProbe = {}) {
  const health = routerProbe.health || {};
  const unhealthyRoutes = Number(health.unhealthyRoutes || 0);
  const ok = Boolean(routerProbe.running && health.ok && unhealthyRoutes === 0);
  const models = Array.isArray(health.models)
    ? health.models.map((item) => typeof item === "string" ? item : item?.id).filter(Boolean)
    : [];
  return {
    ok,
    detail: ok
      ? "real router health passed"
      : health.message || "real router health has not passed",
    models,
    routes: Array.isArray(health.routes) ? health.routes.length : 0,
  };
}

function providerAcceptanceEntry(provider = {}) {
  const lastTest = provider.lastTest || {};
  return {
    ok: true,
    provider: provider.name || provider.displayName || provider.id || "provider",
    providerId: provider.id || provider.providerId || "",
    capability: provider.capability || provider.capabilities?.[0] || "image_generation",
    checkedAt: lastTest.checkedAt || "",
    durationMs: Number.isFinite(Number(lastTest.durationMs)) ? Math.round(Number(lastTest.durationMs)) : 0,
    ...(lastTest.localPath ? { localPath: lastTest.localPath } : {}),
  };
}

function freshPassedTest(lastTest = null) {
  if (!lastTest || lastTest.ok !== true) {
    return false;
  }
  const checkedAtMs = Date.parse(lastTest.checkedAt || "");
  if (!Number.isFinite(checkedAtMs)) {
    return false;
  }
  return Date.now() - checkedAtMs <= 7 * 24 * 60 * 60 * 1000;
}

function windowsInstallerAcceptance(releaseAssets = [], { platform = process.platform, arch = process.arch } = {}) {
  if (platform !== "win32" || arch !== "x64") {
    return {
      ok: true,
      note: `platform ${platform} ${arch} has no Windows installer acceptance requirement`,
    };
  }
  const setup = releaseAssets.find((asset) => String(asset.name || "").toLowerCase() === "codexbridge-windows-x64-setup.exe");
  const portable = releaseAssets.find((asset) => String(asset.name || "").toLowerCase() === "codexbridge-windows-x64-portable.zip");
  const setupOk = Boolean(setup && Number(setup.size || 0) > 0 && String(setup.headerHex || "").toLowerCase().startsWith("4d5a"));
  const portableOk = Boolean(portable && Number(portable.size || 0) > 0 && String(portable.headerHex || "").toLowerCase().startsWith("504b"));
  return {
    ok: setupOk && portableOk,
    setupExe: setup?.path || setup?.name || "",
    portableZip: portable?.path || portable?.name || "",
    setupSize: Number(setup?.size || 0),
    portableSize: Number(portable?.size || 0),
  };
}

async function probeReleaseRouterHealth(config = {}) {
  const host = releaseProbeHost(config?.host);
  const port = Number(config?.port || 15722);
  if (!Number.isFinite(port) || port <= 0) {
    return { running: false, health: null };
  }
  const health = await probeRouterHealth({
    origin: `http://${host}:${port}`,
    timeoutMs: 500,
  });
  return {
    running: Boolean(health?.ok || Number(health?.status || 0) > 0),
    health,
  };
}

function releaseProbeHost(host = "") {
  const clean = String(host || "").trim();
  if (!clean || clean === "0.0.0.0" || clean === "::") {
    return "127.0.0.1";
  }
  return clean;
}

function printReport(check = {}, {
  rootDir = "",
  homeDir = "",
  strictWarnings = false,
  acceptanceReport = null,
  gateReport = null,
  releaseGate = null,
  codeReady = null,
  codeReadyMode = false,
} = {}) {
  const summary = check.summary || {};
  const reportStatus = releaseReportStatus(summary, { strictWarnings });
  console.log("CodexBridge 发布前体检");
  console.log(`数据目录: ${rootDir}`);
  console.log(`Codex 目录: ${homeDir}`);
  if (acceptanceReport?.path) {
    console.log(`真实检查报告: ${acceptanceReport.path} (${acceptanceReport.ok ? "已通过" : "未通过或证据不足"}${acceptanceReport.written ? "，已写入" : ""})`);
  }
  console.log(`结果: ${reportStatus} · 通过 ${summary.pass || 0} · 提醒 ${summary.warn || 0} · 失败 ${summary.fail || 0}`);
  if (gateReport?.path) {
    console.log(`发布门禁报告: ${gateReport.path} (${gateReport.ok ? "已通过" : "未通过"}，已写入)`);
  }
  if (strictWarnings) {
    console.log("严格模式: 提醒项也会阻止正式发包；真实环境验收缺口请交给拿着真实 Key、真实安装包的人补证据，本地代码不要在这里空转。");
  }
  if (releaseGate) {
    const codeStatus = releaseGate.codeOrConfigOk
      ? "已收尾（剩余问题属于真实验收或本机配置）"
      : "需要修复";
    console.log(`仓库代码状态: ${codeStatus}`);
  }
  if (codeReadyMode && codeReady) {
    console.log(`本地代码就绪: ${codeReady.ok ? "通过" : "未通过"}；真实环境验收缺口和本机配置待办不会让这个命令失败。`);
    if (codeReady.ignoredRealEvidenceItemIds?.length) {
      console.log(`本次忽略的真实验收项: ${codeReady.ignoredRealEvidenceItemIds.join(", ")}`);
    }
    if (codeReady.ignoredLocalSetupItemIds?.length) {
      console.log(`本次忽略的本机配置项: ${codeReady.ignoredLocalSetupItemIds.join(", ")}`);
    }
    printBlockingNextActions("仓库代码/配置下一步", codeReady.codeOrConfigBlockingItems);
  }
  if (Array.isArray(releaseGate?.blockingItemIds) && releaseGate.blockingItemIds.length) {
    if (releaseGate.realEvidenceBlockingItemIds?.length) {
      console.log(`真实环境验收缺口: ${releaseGate.realEvidenceBlockingItemIds.join(", ")}`);
    }
    if (releaseGate.localSetupBlockingItemIds?.length) {
      console.log(`本机配置/运行待办: ${releaseGate.localSetupBlockingItemIds.join(", ")}`);
    }
    if (releaseGate.codeOrConfigBlockingItemIds?.length) {
      console.log(`仓库代码/配置阻断项: ${releaseGate.codeOrConfigBlockingItemIds.join(", ")}`);
    }
    printBlockingNextActions("真实验收下一步（交给真实环境测试，不阻塞本地代码收尾）", releaseGate.realEvidenceBlockingItems);
    printBlockingNextActions("本机配置/运行下一步（可交给测试机或当前机器处理）", releaseGate.localSetupBlockingItems);
    printBlockingNextActions("仓库代码/配置下一步", releaseGate.codeOrConfigBlockingItems);
  }
  console.log("");
  for (const item of check.items || []) {
    const marker = item.status === "pass" ? "PASS" : item.status === "fail" ? "FAIL" : "WARN";
    console.log(`[${marker}] ${item.label}`);
    if (item.detail) {
      console.log(`  ${item.detail}`);
    }
    if (item.action) {
      console.log(`  建议：${item.action}`);
    }
  }
  if (summary.fail > 0) {
    console.log("");
    console.log("发布前体检未通过：请先处理 FAIL 项。");
  } else if (strictWarnings && summary.warn > 0) {
    console.log("");
    console.log("严格模式未通过：请先处理 WARN 提醒项；真实验收缺口和本机配置/运行待办可以记录给测试机处理，仓库代码/配置阻断项需要在本仓库修掉。");
  }
}

function printBlockingNextActions(title, items = []) {
  if (!Array.isArray(items) || !items.length) {
    return;
  }
  console.log(`${title}:`);
  for (const item of items) {
    const id = String(item?.id || "unknown").trim() || "unknown";
    const label = String(item?.label || id).trim();
    const action = String(item?.action || item?.detail || "请查看该体检项详情。").trim();
    console.log(`- ${id}: ${label} - ${action}`);
  }
}

function releaseReportStatus(summary = {}, { strictWarnings = false } = {}) {
  const failCount = Number(summary.fail || 0);
  const warnCount = Number(summary.warn || 0);
  if (failCount > 0 || (strictWarnings && warnCount > 0)) {
    return "需要处理";
  }
  if (warnCount > 0) {
    return "有提醒";
  }
  return "可发布";
}

function printHelp() {
  console.log(`CodexBridge release preflight

Usage:
  npm run release:preflight
  npm run release:code-ready
  node scripts/release-preflight.mjs --json
  npm run release:gate -- --platform win32 --arch x64 --release-dir dist-artifacts

Options:
  --data-dir <path>        Use a specific CodexBridge data directory.
  --home-dir <path>        Use a specific Codex home directory.
  --platform <name>        Override platform for update asset checks.
  --arch <name>            Override architecture for update asset checks.
  --acceptance-report <path>
                           Read real Router/provider/installer acceptance JSON.
  --release-asset <name>   Add an expected release asset name. Repeatable.
  --release-dir <path>     Read release asset names from a directory.
  --write-acceptance-report <path>
                           Write real acceptance evidence JSON from current checks.
  --write-gate-report <path>
                           Write the complete release gate JSON report.
  --packaged-smoke-report <path>
                           Read package:win:smoke evidence JSON.
  --code-ready             Exit non-zero only for repository code/config blockers.
  --strict-warnings        Exit non-zero when WARN items exist.
  --json                   Print machine-readable JSON.

Local code readiness:
  Use npm run release:code-ready when real Router/provider/installer evidence is not available yet.
  It still reports missing real evidence, but exits zero if repository code/config is ready.

Final release:
  Use npm run release:gate after real Router/provider/installer evidence is ready.
  It is the strict release gate and treats WARN items as blockers.
`);
}

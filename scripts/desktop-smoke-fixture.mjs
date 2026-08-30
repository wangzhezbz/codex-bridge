import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EMPTY_RESOURCE_SNAPSHOT = Object.freeze({
  codexCliSnapshot: {
    plugins: { ok: true, code: "ok", items: [] },
    mcpServers: { ok: true, code: "ok", items: [] },
  },
  codexPromptInputSnapshot: { ok: true, code: "ok", items: [] },
  codexAppServerSnapshot: {
    ok: true,
    refreshedAt: "2026-08-10T00:00:00.000Z",
    snapshotSource: "desktop-smoke-fixture",
    plugins: { ok: true, items: [] },
    apps: { ok: true, items: [] },
    skills: { ok: true, items: [] },
  },
});

export function createSourceDesktopSmokeFixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-source-smoke-"));
  const homeDir = path.join(rootDir, "home");
  const codexDir = path.join(homeDir, ".codex");
  const dataDir = path.join(rootDir, "data");
  const localAppDataDir = path.join(rootDir, "local-app-data");
  const installRootDir = path.join(os.homedir(), `CB${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`);
  const selectedInstallRootDir = path.join(os.homedir(), `CBS${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`);
  const snapshotPath = path.join(dataDir, "resource-smoke-snapshot.json");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(dataDir);
  fs.mkdirSync(localAppDataDir);
  fs.mkdirSync(selectedInstallRootDir);
  fs.writeFileSync(snapshotPath, `${JSON.stringify(EMPTY_RESOURCE_SNAPSHOT, null, 2)}\n`, "utf8");
  return {
    rootDir,
    homeDir,
    codexDir,
    dataDir,
    localAppDataDir,
    installRootDir,
    selectedInstallRootDir,
    snapshotPath,
    env: {
      CODEXBRIDGE_DESKTOP_SMOKE_HOME: homeDir,
      CODEXBRIDGE_DATA_DIR: dataDir,
      CODEXBRIDGE_DESKTOP_SMOKE_RESOURCE_SNAPSHOT: snapshotPath,
      CODEXBRIDGE_DESKTOP_SMOKE_LOCAL_APP_DATA: localAppDataDir,
      CODEXBRIDGE_DESKTOP_SMOKE_DEFAULT_INSTALL_ROOT: installRootDir,
      CODEXBRIDGE_DESKTOP_SMOKE_SELECTED_INSTALL_ROOT: selectedInstallRootDir,
    },
  };
}

export function cleanupSourceDesktopSmokeFixture(fixture) {
  const logsDir = path.join(fixture.dataDir, "logs");
  const softwareManagerDir = path.join(fixture.dataDir, "software-manager");
  for (const filePath of [
    path.join(logsDir, "desktop-runtime.log"),
    path.join(logsDir, "usage.local.json"),
    fixture.snapshotPath,
    path.join(softwareManagerDir, "state", ".codexbridge-ownership.lock"),
    path.join(softwareManagerDir, "catalog", ".codexbridge-ownership.lock"),
    path.join(softwareManagerDir, "logs", ".codexbridge-ownership.lock"),
    path.join(softwareManagerDir, "state", "ownership.json"),
    path.join(softwareManagerDir, "state", "ownership.json.tmp"),
    path.join(softwareManagerDir, "state", "ownership.json.bak"),
    path.join(softwareManagerDir, "catalog", "catalog-cache.json"),
    path.join(softwareManagerDir, "catalog", "catalog-cache.json.tmp"),
    path.join(softwareManagerDir, "catalog", "catalog-cache.json.bak"),
    path.join(softwareManagerDir, "logs", "software-manager.json"),
    path.join(softwareManagerDir, "logs", "software-manager.json.tmp"),
    path.join(softwareManagerDir, "logs", "software-manager.json.bak"),
  ]) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  for (const directoryPath of [
    path.join(fixture.localAppDataDir, "CBApps"),
    fixture.installRootDir,
    fixture.selectedInstallRootDir,
    fixture.localAppDataDir,
    path.join(softwareManagerDir, "skill-prepares"),
    path.join(softwareManagerDir, "skill-swaps"),
    path.join(softwareManagerDir, "logs"),
    path.join(softwareManagerDir, "catalog"),
    path.join(softwareManagerDir, "journal"),
    path.join(softwareManagerDir, "state"),
    softwareManagerDir,
    logsDir,
    fixture.dataDir,
    fixture.codexDir,
    fixture.homeDir,
    fixture.rootDir,
  ]) {
    if (fs.existsSync(directoryPath)) fs.rmdirSync(directoryPath);
  }
}

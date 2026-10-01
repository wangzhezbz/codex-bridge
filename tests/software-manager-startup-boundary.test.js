import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { createUnavailableSoftwareManagerService } from "../desktop/software-manager/unavailable-service.mjs";

test("an unavailable optional software manager remains read-only while normal desktop startup can continue", async () => {
  const service = createUnavailableSoftwareManagerService({
    platform: "win32",
    reason: "software_manager_startup_failed",
  });

  const snapshot = await service.getSnapshot();
  assert.deepEqual(snapshot, {
    platform: "win32",
    enabled: true,
    readOnly: true,
    pendingRecovery: true,
    unavailableReason: "software_manager_startup_failed",
    tabs: ["install", "update", "uninstall"],
    catalog: { available: false, components: [], skills: [] },
    components: [],
    skills: [],
    rollback: [],
    installRootPath: null,
    task: null,
    logs: [],
    defaults: {
      install: { componentIds: [], skillIds: [] },
      update: { componentIds: [], skillIds: [] },
    },
    logging: { degraded: false, pendingWrites: 0, error: null, recovery: null },
  });
  assert.deepEqual(await service.refresh(), snapshot);
  assert.deepEqual(await service.beginQuit(), { allowQuit: true, reservation: null });
  assert.deepEqual(await service.refreshQuit(null), { allowQuit: true, reservation: null });
  assert.equal(service.releaseQuit(null), false);
  assert.equal(typeof service.subscribe(() => {}), "function");

  for (const action of [
    () => service.chooseInstallRoot("opaque"),
    () => service.startTask({ kind: "install", componentIds: [], skillIds: [] }),
    () => service.cancelTask(),
  ]) {
    await assert.rejects(action, /software_manager_startup_unavailable/u);
  }
});

test("software-manager startup failure is isolated and long recovery remains service-owned", () => {
  const mainSource = fs.readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const runtimeFactorySource = fs.readFileSync(new URL("../desktop/software-manager/runtime-factory.mjs", import.meta.url), "utf8");
  const startup = mainSource.match(/app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*?\n\}\);\n\napp\.on\("before-quit"/u)?.[0] ?? "";
  const construction = startup.indexOf("await getSoftwareManagerRuntime()");
  const constructionCatch = startup.indexOf("catch (error)", construction);
  const constructionCatchEnd = startup.indexOf("\n    }", constructionCatch);
  const constructionCatchBody = startup.slice(constructionCatch, constructionCatchEnd);
  const recoveryComplete = startup.indexOf("configRecoveryComplete = true;", constructionCatchEnd);
  const createWindow = startup.indexOf("createWindow();", recoveryComplete);

  assert.equal(construction >= 0 && constructionCatch > construction
    && recoveryComplete > constructionCatch && createWindow > recoveryComplete, true);
  assert.match(constructionCatchBody, /appendRuntimeLog\(formatError\("softwareManagerStartup", error\)\)/u);
  assert.match(constructionCatchBody, /softwareManagerStartupFailure\s*=\s*error/u);
  assert.doesNotMatch(startup, /runtime\.recoverOffline\(\)/u);
  assert.match(startup.slice(constructionCatchEnd, recoveryComplete), /initializeSoftwareManagerIpc\(\)/u);
  assert.match(runtimeFactorySource, /createSoftwareManagerService\(\{[\s\S]*?recoverTransactions:\s*recoverOffline/u);
});

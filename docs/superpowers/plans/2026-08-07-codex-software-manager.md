# CodexBridge Software Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Windows-only CodexBridge software manager that safely installs, updates, uninstalls, and rolls back ChatGPT, V2RayN, managed Git, and individually selected Skills through a new isolated signed release environment.

**Architecture:** Keep Router and model traffic untouched. A new `desktop/software-manager/` domain owns catalog trust, path policy, downloads, archive validation, Windows host operations, component adapters, ownership state, transactions, and orchestration; `desktop/main.cjs`, `desktop/preload.cjs`, and the existing renderer only provide lifecycle and UI wiring. Shared catalog code and isolated publishing/deployment tools live outside the desktop runtime path and are deployed only to `/opt/shanhai/codexbridge-installer/` after local and CI evidence passes.

**Tech Stack:** Node.js 24, Electron 39, native `node:test`, `undici`, `zod`, `yauzl`, `7zip-bin`, Windows `reg.exe`, fixed local PowerShell Authenticode query, Electron `shell.writeShortcutLink`, GitHub Actions Windows runners, Node server-side publishing scripts, nginx, systemd timers.

## Global Constraints

- Do not modify, stop, install, update, uninstall, or launch real ChatGPT, V2RayN, or Git on the current development machine.
- Do not modify the current machine's registry, PATH, desktop shortcuts, `%USERPROFILE%\.codex`, V2RayN configuration, Git configuration, SSH keys, credentials, or repositories.
- All local integration tests use dependency-injected host adapters and temporary directories; real acceptance runs only on a disposable Windows machine.
- Never call mocks, fixture packages, static checks, CI transactions, or package smokes a real installation acceptance.
- Do not modify the old `/install/`, `/install-test/`, their directories, signing keys, timers, manifests, or object prefixes.
- Build only the new test environment at `/opt/shanhai/codexbridge-installer/`, `https://shanhaiyouling.com/codexbridge-install-test/`, and `/codexbridge-test/packages/`; do not create or call the future production endpoint without explicit authorization.
- Windows exposes the feature; macOS and other platforms do not render the navigation item and cannot invoke software-manager IPC.
- The renderer may send only fixed action names, component IDs, Skill IDs, and a directory returned by the main-process chooser; it may not send commands, scripts, URLs, or deletion paths.
- ChatGPT uses `c`, `cp`, and `ct` slots; other component directories retain readable names.
- Preserve `%USERPROFILE%\.codex`, V2RayN user configuration, Git configuration/SSH/credentials/repositories, and all external ChatGPT/V2RayN installations.
- Download defaults: ChatGPT selected; V2RayN, Git, and all Skills unselected. Update defaults: installed components with newer versions selected; current versions disabled; missing components unselected. Uninstall defaults: everything unselected.
- The rollback tab is absent unless at least one eligible rollback record exists. First installs, Skills, and external Git never create rollback records.
- A successful update retains current and previous versions only; a successful rollback removes the rejected newer version and consumes the rollback record.
- Selected same-name Skills are replaced without backup or restoration, but only after exact canonical direct-child path validation.
- Component execution is sequential and component-level results are independent; only one software-manager task may run at a time.
- Existing Router, model adapters, MCP, history, streaming, image/file handling, custom models, and desktop update behavior must continue to pass their current regression suites.

## File Structure

- `shared/software-manager/catalog-schema.mjs`: canonical catalog Zod schema, stable component IDs, URL and version helpers shared by client and publisher.
- `desktop/software-manager/catalog-public-key.mjs`: explicit unprovisioned sentinel replaced with the isolated environment's public key only after Task 14 creates that independent key.
- `desktop/software-manager/catalog-trust.mjs`: detached signature verification with the pinned or test-injected trust key.
- `desktop/software-manager/path-policy.mjs`: install-root, managed-path, and Skill-target authorization.
- `desktop/software-manager/safe-delete.mjs`: non-following, one-explicit-file-at-a-time deletion of authorized trees.
- `desktop/software-manager/state-store.mjs`: atomic ownership state and rollback records.
- `desktop/software-manager/transaction-journal.mjs`: write-ahead phase journal and crash recovery decisions.
- `desktop/software-manager/download-manager.mjs`: Range resume, `.part`, progress, retry, length, and SHA256.
- `desktop/software-manager/archive-service.mjs`: safe ZIP/7z listing and extraction.
- `desktop/software-manager/windows-host.mjs`: registry discovery, Authenticode query, process control, shortcuts, and fixed installer invocation behind an injectable interface.
- `desktop/software-manager/version-slots.mjs`: current/previous/staging transitions and peak-space planning.
- `desktop/software-manager/component-adapters.mjs`: ChatGPT, V2RayN, Git, and Skill prepare/commit/verify/uninstall rules.
- `desktop/software-manager/service.mjs`: single-task orchestration, snapshots, cancellation, logs, and progress events.
- `desktop/software-manager/ipc.mjs`: trusted fixed IPC registration and payload validation.
- `desktop/renderer/software-manager-ui.js`: renderer-only state machine and HTML rendering helpers.
- `desktop/renderer/index.html`, `desktop/renderer/styles.css`, `desktop/renderer/app.js`: navigation, approved page shell, styles, and event wiring.
- `desktop/main.cjs`, `desktop/preload.cjs`: lifecycle, dialog, service creation, and narrow bridge API.
- `scripts/software-manager/`: catalog assembly, package inspection, manual ChatGPT/Skills publication, V2RayN/Git synchronization, and retention scripts.
- `deploy/codexbridge-installer/`: isolated nginx, environment, systemd service/timer, and deploy verification assets.
- `tests/software-manager-*.test.js`: pure, temp-directory, fake-host, renderer, and contract tests.
- `.github/workflows/desktop-portable.yml`: non-mutating Windows transaction job and package-content checks.

---

### Task 1: Shared Signed Catalog Contract

**Files:**
- Create: `shared/software-manager/catalog-schema.mjs`
- Create: `desktop/software-manager/catalog-public-key.mjs`
- Create: `desktop/software-manager/catalog-trust.mjs`
- Create: `tests/software-manager-catalog.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `parseCatalog(value)`, `compareVersions(left, right)`, `resolveCatalogAssetUrl(catalogUrl, assetUrl)`, `verifyCatalogEnvelope({ jsonBytes, signatureText, publicKeyPem, catalogUrl })`.
- Consumes: no feature code; tests generate ephemeral RSA keys and never use the future production key.

- [ ] **Step 1: Add archive dependencies and write failing catalog tests**

Run:

```powershell
npm install yauzl@3.2.0 7zip-bin@5.2.0
```

Create tests that assert a valid RSA-SHA256 detached signature and strict schema pass, while a changed byte, unknown component ID, non-HTTPS asset, duplicate Skill ID, path-bearing ID, or production-origin URL fails:

```js
test("catalog accepts a signed test-origin manifest", () => {
  const signed = signedFixture({ components: [chatgptFixture()], skills: [skillFixture("documents")] });
  const result = verifyCatalogEnvelope({ ...signed, catalogUrl: TEST_CATALOG_URL });
  assert.equal(result.components[0].id, "chatgpt");
});

test("catalog rejects a signature after one JSON byte changes", () => {
  const signed = signedFixture({ components: [chatgptFixture()] });
  assert.throws(
    () => verifyCatalogEnvelope({ ...signed, jsonBytes: Buffer.concat([signed.jsonBytes, Buffer.from(" ")]), catalogUrl: TEST_CATALOG_URL }),
    /signature/i,
  );
});
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `node --test tests/software-manager-catalog.test.js`

Expected: FAIL because `catalog-schema.mjs` and `catalog-trust.mjs` do not exist.

- [ ] **Step 3: Implement the strict schema and detached signature verifier**

Use stable IDs and exact test origin:

```js
export const COMPONENT_IDS = Object.freeze(["chatgpt", "v2rayn", "git"]);
export const TEST_CATALOG_ORIGIN = "https://shanhaiyouling.com";
export const TEST_CATALOG_PATH = "/codexbridge-install-test/component-catalog.json";

export function verifyCatalogEnvelope({ jsonBytes, signatureText, publicKeyPem, catalogUrl }) {
  const url = new URL(catalogUrl);
  if (url.protocol !== "https:" || url.origin !== TEST_CATALOG_ORIGIN || url.pathname !== TEST_CATALOG_PATH) {
    throw catalogError("catalog_origin_rejected");
  }
  const signature = Buffer.from(String(signatureText).replace(/^\uFEFF/, "").replace(/\s+/g, ""), "base64");
  if (!crypto.verify("RSA-SHA256", jsonBytes, publicKeyPem, signature)) {
    throw catalogError("catalog_signature_invalid");
  }
  return parseCatalog(JSON.parse(jsonBytes.toString("utf8")));
}
```

Until Task 14 provisions the independent server key, `catalog-public-key.mjs` must export `CATALOG_PUBLIC_KEY_SPKI = null` and `CATALOG_PUBLIC_KEY_SHA256 = null`. Normal runtime returns `catalog_trust_not_provisioned`; tests may pass only an explicit ephemeral key.

- [ ] **Step 4: Run catalog tests and the dependency audit**

Run: `node --test tests/software-manager-catalog.test.js && npm run audit:prod`

Expected: all catalog tests PASS and the production dependency audit meets the existing moderate threshold.

- [ ] **Step 5: Commit the catalog contract**

```powershell
git add package.json package-lock.json shared/software-manager/catalog-schema.mjs desktop/software-manager/catalog-public-key.mjs desktop/software-manager/catalog-trust.mjs tests/software-manager-catalog.test.js
git commit -m "Add signed software catalog contract"
```

### Task 2: Path Policy and Ownership State

**Files:**
- Create: `desktop/software-manager/path-policy.mjs`
- Create: `desktop/software-manager/safe-delete.mjs`
- Create: `desktop/software-manager/state-store.mjs`
- Create: `tests/software-manager-path-policy.test.js`
- Create: `tests/software-manager-safe-delete.test.js`
- Create: `tests/software-manager-state-store.test.js`

**Interfaces:**
- Produces: `validateInstallRoot({ candidate, env, maxRelativePath, access })`, `resolveSkillTarget({ skillsRoot, skillId, realpath, lstat })`, `isOwnedPath({ target, ownership })`, `deleteAuthorizedTree({ target, authorizedRoot, fsApi })`, `createOwnershipStore({ stateDir, fsApi })`.
- State schema: `{ schemaVersion: 1, installRoot, components, skills, shortcuts, rollback, activeTask, lastTask }`.

- [ ] **Step 1: Write failing table-driven path and atomic-state tests**

Cover drive roots, Windows/Program Files, Desktop/Documents, `.codex`, UNC, unwritable paths, peak path length, sibling-prefix escapes, `..`, reparse points, direct-child Skills, corrupt state fallback, and interrupted atomic rename:

```js
for (const candidate of ["C:\\\\", "C:\\\\Windows", "C:\\\\Users\\me\\.codex", "\\\\server\\share"]) {
  test(`rejects unsafe install root ${candidate}`, async () => {
    const result = await validateInstallRoot({ candidate, env: fixtureEnv(), maxRelativePath: 180, access: allowAccess });
    assert.equal(result.ok, false);
  });
}

test("Skill target must be a non-link direct child of the canonical Skills root", async () => {
  await assert.rejects(
    resolveSkillTarget({ skillsRoot, skillId: "documents", realpath, lstat: async () => ({ isSymbolicLink: () => true }) }),
    /reparse|link/i,
  );
});
```

The safe-delete suite asserts that the walker rejects roots, siblings, links, and reparse points; deletes each regular file by one explicit normalized path; removes only empty directories after their children; and never calls `fs.rm({ recursive: true })` or a shell deletion command.

- [ ] **Step 2: Verify both tests fail before implementation**

Run: `node --test tests/software-manager-path-policy.test.js tests/software-manager-safe-delete.test.js tests/software-manager-state-store.test.js`

Expected: FAIL on missing modules.

- [ ] **Step 3: Implement canonical path authorization and atomic JSON state**

The Skill resolver must derive the path from the validated ID, never accept it from renderer input:

```js
export async function resolveSkillTarget({ skillsRoot, skillId, realpath, lstat }) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skillId)) throw pathError("skill_id_rejected");
  const root = await realpath(skillsRoot);
  const target = path.resolve(root, skillId);
  if (path.dirname(target).toLowerCase() !== root.toLowerCase()) throw pathError("skill_path_escape");
  const stat = await lstat(target).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (stat?.isSymbolicLink() || stat?.isReparsePoint?.()) throw pathError("skill_reparse_point");
  return target;
}
```

Write state to `ownership.json.tmp`, flush, rename to `ownership.json`, and retain one validated `ownership.json.bak` without following links.

Implement deletion as a bounded depth-first walk. Re-authorize every discovered child beneath `authorizedRoot`, reject links/reparse points, call `fsApi.unlink(exactFile)` for each file, and call `fsApi.rmdir(exactEmptyDirectory)` only after its children are gone. Do not use recursive filesystem deletion APIs.

- [ ] **Step 4: Run path/state tests**

Run: `node --test tests/software-manager-path-policy.test.js tests/software-manager-safe-delete.test.js tests/software-manager-state-store.test.js`

Expected: PASS with all writes under test temporary directories.

- [ ] **Step 5: Commit path and state primitives**

```powershell
git add desktop/software-manager/path-policy.mjs desktop/software-manager/safe-delete.mjs desktop/software-manager/state-store.mjs tests/software-manager-path-policy.test.js tests/software-manager-safe-delete.test.js tests/software-manager-state-store.test.js
git commit -m "Add software manager path and state guards"
```

### Task 3: Resumable Verified Downloads

**Files:**
- Create: `desktop/software-manager/download-manager.mjs`
- Create: `tests/software-manager-download.test.js`

**Interfaces:**
- Consumes: catalog asset `{ url, size, sha256 }` from Task 1.
- Produces: `createDownloadManager({ fetchImpl, fsApi, retryPolicy })` with `download({ asset, destination, signal, onProgress }): Promise<{ path, size, sha256, resumed }>`.

- [ ] **Step 1: Write a failing local-HTTP download suite**

Tests must assert `Range: bytes=N-`, correct 206 append, 200 restart when Range is ignored, bounded retry on connection reset, cancellation preserving exactly one `.part`, length mismatch rejection, SHA mismatch rejection, and no Authorization forwarding across redirects:

```js
test("resumes a partial package and verifies final SHA256", async () => {
  await fs.writeFile(`${destination}.part`, body.subarray(0, 7));
  const result = await manager.download({ asset, destination, signal: AbortSignal.timeout(5_000), onProgress() {} });
  assert.equal(result.resumed, true);
  assert.deepEqual(await fs.readFile(destination), body);
  assert.equal(await exists(`${destination}.part`), false);
});
```

- [ ] **Step 2: Run the download suite and confirm failure**

Run: `node --test tests/software-manager-download.test.js`

Expected: FAIL because the download manager is absent.

- [ ] **Step 3: Implement stream-to-part, resume, retry, and final verification**

Use `pipeline(Readable.fromWeb(response.body), writeStream)` and rename only after hash and length pass. Progress payload is fixed:

```js
onProgress({ phase: "download", receivedBytes, totalBytes: asset.size, percent, bytesPerSecond });
```

Reject redirect origins outside the signed asset URL's HTTPS origin unless the catalog contains the final immutable URL.

- [ ] **Step 4: Run download tests**

Run: `node --test tests/software-manager-download.test.js`

Expected: PASS; test server binds only loopback and temporary files are removed by each test fixture.

- [ ] **Step 5: Commit verified downloads**

```powershell
git add desktop/software-manager/download-manager.mjs tests/software-manager-download.test.js
git commit -m "Add resumable verified component downloads"
```

### Task 4: Safe ZIP and 7z Extraction

**Files:**
- Create: `desktop/software-manager/archive-service.mjs`
- Create: `tests/software-manager-archive.test.js`
- Create: `tests/fixtures/software-manager/README.md`

**Interfaces:**
- Produces: `createArchiveService({ sevenZipPath, spawnFile, fsApi })`, `inspectArchive({ format, archivePath })`, `extractArchive({ format, archivePath, destination, signal })`.
- Returns: `{ entries: [{ path, size, directory }], maxRelativePath, totalUnpackedBytes }`.

- [ ] **Step 1: Write failing archive policy tests using generated tiny fixtures**

Cover normal ZIP, normal 7z through a fake process adapter, absolute paths, drive paths, `..`, slash/backslash traversal, duplicate normalized names, symlink/reparse metadata, oversized entry count, declared unpacked-size bomb, and cancellation before extraction:

```js
test("rejects a ZIP entry that escapes through backslashes", async () => {
  const archivePath = await writeZipFixture([{ name: "safe\\..\\..\\outside.txt", body: "x" }]);
  await assert.rejects(service.inspectArchive({ format: "zip", archivePath }), /archive_path_escape/);
});
```

- [ ] **Step 2: Run the archive suite and confirm missing implementation**

Run: `node --test tests/software-manager-archive.test.js`

Expected: FAIL on module import.

- [ ] **Step 3: Implement lazy ZIP enumeration and fixed 7z command plans**

ZIP extraction must validate every entry before opening output files. The 7z adapter may invoke only the bundled binary with fixed argument arrays:

```js
const listArgs = ["l", "-slt", "-ba", "--", archivePath];
const extractArgs = ["x", "-y", `-o${destination}`, "--", archivePath];
```

After 7z extraction, recursively enumerate without following links and reject any real path outside `destination`; never run an archive-contained script.

- [ ] **Step 4: Run archive tests and dependency content check**

Run: `node --test tests/software-manager-archive.test.js && node scripts/package-content-policy.mjs`

Expected: archive tests PASS and current package policy remains green.

- [ ] **Step 5: Commit archive support**

```powershell
git add desktop/software-manager/archive-service.mjs tests/software-manager-archive.test.js tests/fixtures/software-manager/README.md
git commit -m "Add guarded software package extraction"
```

### Task 5: Windows Host Adapter Without Real-Machine Tests

**Files:**
- Create: `desktop/software-manager/windows-host.mjs`
- Create: `tests/software-manager-windows-host.test.js`

**Interfaces:**
- Produces: `createWindowsHost({ platform, execFile, electronShell, registryReader, processLister, env })`.
- Methods: `discoverGit()`, `verifyAuthenticode(filePath)`, `stopOwnedProcesses(executablePaths)`, `launchOwned(executablePath)`, `createShortcut(record)`, `removeRecordedShortcut(record)`, `runGitInstaller(plan)`, `runGitUninstaller(plan)`.

- [ ] **Step 1: Write failing command-plan and ownership tests**

Assert platform rejection, unique Git registry matching, multi-Git conflict, portable Git refusal, fixed Authenticode command, exact installer arguments, executable-path process ownership, collision names `ChatGPT（1）.lnk`, and deletion of only the recorded shortcut:

```js
test("Git installer command uses a fixed verified silent argument list", async () => {
  const host = createFakeWindowsHost();
  await host.runGitInstaller({ installerPath: "D:\\staging\\Git.exe", targetDir: "D:\\CBApps\\Git\\current" });
  assert.deepEqual(host.calls.execFile[0].args, [
    "/VERYSILENT", "/NORESTART", "/NOCANCEL", "/SP-", "/CLOSEAPPLICATIONS",
    "/o:PathOption=Cmd", "/DIR=D:\\CBApps\\Git\\current",
  ]);
});
```

- [ ] **Step 2: Run host tests and verify they fail**

Run: `node --test tests/software-manager-windows-host.test.js`

Expected: FAIL on missing module.

- [ ] **Step 3: Implement dependency-injected Windows operations**

Use `reg.exe query` with fixed keys/args for uninstall records. Authenticode uses a fixed local PowerShell command that reads the package path only from `CB_SM_PACKAGE_PATH`; renderer data never enters the command string:

```js
const AUTHENTICODE_COMMAND = "$s=Get-AuthenticodeSignature -LiteralPath $env:CB_SM_PACKAGE_PATH; @{Status=[string]$s.Status; Thumbprint=$s.SignerCertificate.Thumbprint; Subject=$s.SignerCertificate.Subject}|ConvertTo-Json -Compress";
```

Create shortcuts with Electron `shell.writeShortcutLink`; do not use WScript or old installer scripts.

- [ ] **Step 4: Run host tests**

Run: `node --test tests/software-manager-windows-host.test.js`

Expected: PASS with fake registry/process/shell adapters and zero real OS writes.

- [ ] **Step 5: Commit the Windows host boundary**

```powershell
git add desktop/software-manager/windows-host.mjs tests/software-manager-windows-host.test.js
git commit -m "Add isolated Windows software host adapter"
```

### Task 6: Version Slots and Transaction Journal

**Files:**
- Create: `desktop/software-manager/version-slots.mjs`
- Create: `desktop/software-manager/transaction-journal.mjs`
- Create: `tests/software-manager-version-slots.test.js`
- Create: `tests/software-manager-transaction.test.js`

**Interfaces:**
- Consumes: authorized roots from Task 2 and `fsApi` injection.
- Produces: `createVersionSlotManager({ fsApi, ownershipStore })`, `planPeakBytes({ current, previous, incoming })`, `promotePreparedVersion(plan)`, `rollbackVersion(componentId)`, `createTransactionJournal({ journalDir, fsApi })`, `recoverTransactions({ journal, slots })`.

- [ ] **Step 1: Write failing two-generation and crash-matrix tests**

Use fake directory trees to test first install, first update, third-version cleanup only after promotion, failed promotion, one-time rollback, failed rollback, missing slot, journal phases `prepared`, `old_moved`, `new_promoted`, `state_committed`, and idempotent recovery:

```js
test("a second update deletes the oldest version only after new state commits", async () => {
  const slots = createFixtureSlots({ current: "2", previous: "1", prepared: "3" });
  await slots.promotePreparedVersion(updatePlan("3"));
  assert.deepEqual(await slots.listVersions(), { current: "3", previous: "2", staging: null });
  assert.equal(await slots.existsVersion("1"), false);
});
```

- [ ] **Step 2: Run both suites and confirm failure**

Run: `node --test tests/software-manager-version-slots.test.js tests/software-manager-transaction.test.js`

Expected: FAIL because slot and journal modules are missing.

- [ ] **Step 3: Implement write-ahead phases and component-specific slot names**

ChatGPT maps to `{ current: "c", previous: "cp", staging: "ct" }`; V2RayN and managed Git map to readable subdirectories. Every filesystem rename is preceded by an atomic journal write:

```js
await journal.record({ taskId, componentId, phase: "old_moved", from: currentPath, to: previousPath });
await fsApi.rename(preparedPath, currentPath);
await journal.record({ taskId, componentId, phase: "new_promoted", currentPath });
```

Recovery chooses the last fully verified slot; it never deletes the only complete version.

- [ ] **Step 4: Run slot and recovery tests**

Run: `node --test tests/software-manager-version-slots.test.js tests/software-manager-transaction.test.js`

Expected: PASS and every fixture remains inside `os.tmpdir()`.

- [ ] **Step 5: Commit version transaction support**

```powershell
git add desktop/software-manager/version-slots.mjs desktop/software-manager/transaction-journal.mjs tests/software-manager-version-slots.test.js tests/software-manager-transaction.test.js
git commit -m "Add transactional software version slots"
```

### Task 7: Component Adapters

**Files:**
- Create: `desktop/software-manager/component-adapters.mjs`
- Create: `tests/software-manager-components.test.js`

**Interfaces:**
- Consumes: catalog, archive, downloader, path policy, Windows host, slots, ownership store.
- Produces: `createComponentAdapters(deps)` returning adapters with `inspectInstalled(context)`, `prepare(context)`, `commit(context)`, `verify(context)`, `uninstall(context)`, and `rollback(context)`.
- Result shape: `{ componentId, action, status: "succeeded"|"skipped"|"failed", versionBefore, versionAfter, message, rollbackAvailable }`.

- [ ] **Step 1: Write failing behavior tests for all four component types**

ChatGPT tests assert `c/cp/ct`, preserved `.codex`, collision-safe shortcut, restart only if previously running, and ignored external installs. V2RayN tests assert shared persistent config, owned process path, and V2RayN shortcut. Git tests assert existing registered Git updates in place, unmanaged ambiguity blocks, managed Git rollback, exact target `git.exe --version`, and no shortcut. Skill tests assert same-name replacement, no backup, exact selected Skill only, and `SKILL.md` hash verification:

```js
test("same-name Skill replacement never receives a renderer path", async () => {
  const result = await adapters.skills.commit({ skillIds: ["documents"], skillsRoot, catalog });
  assert.equal(result[0].status, "succeeded");
  assert.deepEqual(host.deletedTargets, [path.join(skillsRoot, "documents")]);
  assert.equal(host.deletedTargets.some((target) => target === skillsRoot), false);
});
```

- [ ] **Step 2: Run the component suite and confirm failure**

Run: `node --test tests/software-manager-components.test.js`

Expected: FAIL on missing adapters.

- [ ] **Step 3: Implement ChatGPT and V2RayN adapters**

Both adapters must follow `prepare -> verify staging -> journal -> stop owned running process -> promote -> shortcut -> verify final -> optional restart`. V2RayN state stores its configuration root separately from version roots; promotion never moves or deletes that configuration root.

- [ ] **Step 4: Implement Git and Skill adapters**

External Git may be changed only when `discoverGit()` returns exactly one registered installation and the user explicitly selected Git. Managed Git state records the install root and supports slots; external Git records no rollback. Skill operations resolve every target from the signed Skill ID and canonical root, then replace only that direct child.

- [ ] **Step 5: Run component tests**

Run: `node --test tests/software-manager-components.test.js`

Expected: PASS with fake executables and no real program launches.

- [ ] **Step 6: Commit component adapters**

```powershell
git add desktop/software-manager/component-adapters.mjs tests/software-manager-components.test.js
git commit -m "Add software component adapters"
```

### Task 8: Single-Task Orchestration, Cancellation, and Logs

**Files:**
- Create: `desktop/software-manager/service.mjs`
- Create: `tests/software-manager-service.test.js`

**Interfaces:**
- Consumes: all Tasks 1-7 services through dependency injection.
- Produces: `createSoftwareManagerService(deps)` with `getSnapshot()`, `chooseInstallRoot(candidate)`, `refresh()`, `startTask(request)`, `cancelTask()`, `recoverPending()`, `hasCriticalTask()`, `prepareForQuit()` and event `subscribe(listener)`.
- Accepted requests: `{ kind: "install"|"update"|"uninstall"|"rollback", componentIds: string[], skillIds: string[], installRootToken?: string }`.

- [ ] **Step 1: Write failing orchestration tests**

Cover platform disabled, catalog unavailable read-only snapshot, defaults, sequential execution, partial success, duplicate task rejection, cancel in download, cancel disabled during critical commit/delete, 500 UI log lines, redaction, disk log sink, rollback-tab visibility, and quit decisions:

```js
test("continues with the next component after one independent failure", async () => {
  const service = fixtureService({ chatgpt: failingAdapter(), v2rayn: passingAdapter() });
  const result = await service.startTask({ kind: "install", componentIds: ["chatgpt", "v2rayn"], skillIds: [] });
  assert.deepEqual(result.components.map(({ status }) => status), ["failed", "succeeded"]);
});

test("rollback tab is absent when no eligible record exists", async () => {
  assert.equal((await fixtureService().getSnapshot()).tabs.includes("rollback"), false);
});
```

- [ ] **Step 2: Run service tests and confirm failure**

Run: `node --test tests/software-manager-service.test.js`

Expected: FAIL because `service.mjs` does not exist.

- [ ] **Step 3: Implement snapshot/default planning and the sequential queue**

Use an internal `AbortController` only for cancellable phases. Emit fixed events:

```js
listener({ type: "snapshot", snapshot });
listener({ type: "progress", taskId, componentId, phase, percent, cancellable, message });
listener({ type: "finished", taskId, result });
```

Redact bearer tokens, API keys, registration codes, subscription URLs, credentials, and query strings before both UI and file logging.

- [ ] **Step 4: Implement recovery and quit decisions**

`recoverPending()` runs before accepting IPC tasks. `prepareForQuit()` returns `{ allowQuit: true }`, `{ allowQuit: false, reason: "critical" }`, or `{ allowQuit: false, reason: "running", canCancel: true }`; it does not show UI itself.

- [ ] **Step 5: Run service tests**

Run: `node --test tests/software-manager-service.test.js`

Expected: PASS with fake clock, catalog, host, and storage.

- [ ] **Step 6: Commit orchestration**

```powershell
git add desktop/software-manager/service.mjs tests/software-manager-service.test.js
git commit -m "Add software manager task orchestration"
```

### Task 9: Trusted IPC and Electron Lifecycle Wiring

**Files:**
- Create: `desktop/software-manager/ipc.mjs`
- Create: `tests/software-manager-ipc.test.js`
- Modify: `desktop/main.cjs`
- Modify: `desktop/preload.cjs`
- Modify: `tests/desktop-window-security.test.js`

**Interfaces:**
- Consumes: `createSoftwareManagerService()` and the existing trusted IPC registrar.
- Produces IPC: `softwareManager:getSnapshot`, `softwareManager:selectInstallRoot`, `softwareManager:refresh`, `softwareManager:startTask`, `softwareManager:cancelTask`; event `softwareManager:event`.
- Preload API: `getSoftwareManagerSnapshot()`, `selectSoftwareManagerInstallRoot()`, `refreshSoftwareManager()`, `startSoftwareManagerTask(request)`, `cancelSoftwareManagerTask()`, `onSoftwareManagerEvent(callback)`.

- [ ] **Step 1: Write failing IPC authorization and payload tests**

Assert non-Windows rejection, untrusted webContents rejection through the existing registrar, unknown task kind, unknown component/Skill ID, renderer-supplied path/URL/command fields, duplicate IDs, excessive selection count, and valid fixed payload:

```js
await assert.rejects(
  invoke("softwareManager:startTask", { kind: "install", componentIds: ["chatgpt"], installRoot: "C:\\attacker" }),
  /payload_rejected/,
);
```

- [ ] **Step 2: Run focused IPC and window security tests**

Run: `node --test tests/software-manager-ipc.test.js tests/desktop-window-security.test.js`

Expected: new IPC test FAILS; existing window-security tests remain PASS.

- [ ] **Step 3: Register lazy Windows-only service creation in main**

Load `desktop/software-manager/service.mjs` only on `win32`; pass `dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })` through a main-process callback that returns an opaque remembered-root token. On startup run journal recovery without fetching packages or touching external programs.

- [ ] **Step 4: Add the narrow preload API and task event forwarding**

The preload must not expose generic invoke, filesystem, process, URL, or command methods. Register one listener and return an unsubscribe closure:

```js
onSoftwareManagerEvent: (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on("softwareManager:event", listener);
  return () => ipcRenderer.removeListener("softwareManager:event", listener);
},
```

- [ ] **Step 5: Integrate true-quit confirmation without changing close-to-tray behavior**

Before the existing managed quit completes, consult `prepareForQuit()`. A critical phase blocks quit with a Chinese explanation; a cancellable phase offers “继续后台运行” and “取消任务并退出”. Closing the window still hides to tray and never cancels the task.

- [ ] **Step 6: Run IPC, lifecycle syntax, and security tests**

Run: `node --check desktop/main.cjs && node --check desktop/preload.cjs && node --test tests/software-manager-ipc.test.js tests/desktop-window-security.test.js`

Expected: PASS.

- [ ] **Step 7: Commit Electron integration**

```powershell
git add desktop/software-manager/ipc.mjs desktop/main.cjs desktop/preload.cjs tests/software-manager-ipc.test.js tests/desktop-window-security.test.js
git commit -m "Wire software manager into trusted desktop IPC"
```

### Task 10: Approved Software Manager UI

**Files:**
- Create: `desktop/renderer/software-manager-ui.js`
- Create: `tests/software-manager-renderer.test.js`
- Modify: `desktop/renderer/index.html`
- Modify: `desktop/renderer/styles.css`
- Modify: `desktop/renderer/app.js`
- Modify: `tests/desktop-renderer.test.js`
- Modify: `tests/desktop-css.test.js`

**Interfaces:**
- Consumes: preload methods and snapshots/events from Task 9.
- Produces: `window.CodexBridgeSoftwareManagerUI` with `createInitialState()`, `reduce(state, action)`, `defaultSelection(snapshot, tab)`, `render(root, state)`, `readSelection(root)`.

- [ ] **Step 1: Write failing renderer state and static DOM tests**

Assert Windows-only navigation, one `软件管理` entry, four internal views, rollback tab completely absent without a record, approved defaults, unified searchable fixed-height Skills list on install/uninstall, no “同时删除” wording, Git ownership/path display, registration link, confirmation warning, disabled cancel in critical phases, and 500-line display cap:

```js
test("rollback markup is omitted instead of disabled", () => {
  const html = renderFixture({ tabs: ["install", "update", "uninstall"], rollback: [] });
  assert.doesNotMatch(html, /data-software-tab="rollback"/);
  assert.doesNotMatch(html, /回滚.*暂无/);
});
```

- [ ] **Step 2: Run renderer tests and confirm failure**

Run: `node --test tests/software-manager-renderer.test.js tests/desktop-renderer.test.js tests/desktop-css.test.js`

Expected: new renderer tests FAIL while existing tests remain PASS.

- [ ] **Step 3: Add Windows-only navigation and page shell**

Place `software-manager-ui.js` before `app.js`. The nav item starts hidden in HTML and is revealed only when snapshot platform is `win32`; non-Windows never creates a visible software manager control.

- [ ] **Step 4: Implement the four tab views and unified Skills picker**

Use the already approved labels: `下载安装`, `检查更新`, `卸载软件`, and conditional `回滚`. Both install and uninstall use the same renderer function:

```js
renderSkillPicker({ mode: "install"|"uninstall", items, selectedIds, query, maxVisibleRows: 6 });
```

The confirmation panel always lists exact selected components and adds `同名 Skill 将被替换，原内容不会保留。` when any Skill is selected for install.

- [ ] **Step 5: Wire lazy loading, progress, cancellation, and results**

Fetch the first snapshot only when the user first opens `软件管理`. Never put software-manager state into Router config state. Task events update only the software-manager root; existing route/model rendering functions are not called.

- [ ] **Step 6: Add responsive styles matching the approved B layout**

Use the existing panel/color/spacing variables; provide two-column cards above 980px and one-column below 980px. The Skills list has fixed `max-height`, internal scroll, sticky search, and visible focus outlines.

- [ ] **Step 7: Run renderer and accessibility-oriented static tests**

Run: `node --test tests/software-manager-renderer.test.js tests/desktop-renderer.test.js tests/desktop-css.test.js`

Expected: PASS; no visual test opens or changes installed programs.

- [ ] **Step 8: Commit the UI**

```powershell
git add desktop/renderer/software-manager-ui.js desktop/renderer/index.html desktop/renderer/styles.css desktop/renderer/app.js tests/software-manager-renderer.test.js tests/desktop-renderer.test.js tests/desktop-css.test.js
git commit -m "Add Windows software management interface"
```

### Task 11: Package Contents and Non-Mutating Windows CI

**Files:**
- Modify: `scripts/package-windows.mjs`
- Modify: `scripts/package-content-policy.mjs`
- Modify: `scripts/smoke-packaged-windows.mjs`
- Modify: `scripts/release-preflight.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/desktop-portable.yml`
- Create: `tests/software-manager-package.test.js`
- Create: `tests/software-manager-ci-transaction.test.js`

**Interfaces:**
- Consumes: runtime files from Tasks 1-10.
- Produces: `npm run test:software-manager`, packaged 7z binary/license checks, and `CODEXBRIDGE_SOFTWARE_MANAGER_FAKE_HOST=1` CI transaction mode.

- [ ] **Step 1: Write failing package-content tests**

Assert Windows packages contain the required `7zip-bin` Windows executable and license, contain no private keys, `.part`, transaction journals, ownership state, test fixtures, or server environment files, and macOS packages contain no usable Windows software-manager entrypoint:

```js
test("packaged runtime contains public trust code but no private key material", () => {
  assert.equal(paths.some((value) => /catalog-trust\.mjs$/i.test(value)), true);
  assert.equal(paths.some((value) => /\.(pem|key|p12|pfx)$/i.test(value)), false);
});
```

- [ ] **Step 2: Run package tests and confirm the missing rules**

Run: `node --test tests/software-manager-package.test.js`

Expected: FAIL until packaging explicitly retains runtime dependencies and excludes publisher/deploy state.

- [ ] **Step 3: Add package rules and the aggregate test script**

Add:

```json
"test:software-manager": "node --test tests/software-manager-*.test.js"
```

Extend release preflight to verify the test catalog URL constant, 7z executable hash, license presence, and absence of private-key extensions. Until Task 14 provisions the independent test-environment public key, normal `release:code-ready` must fail with `catalog_trust_not_provisioned`; only fake-host tests may inject their ephemeral public key.

- [ ] **Step 4: Add a Windows fake-host transaction job**

The job creates an isolated runner-temp root and exercises fixture install `1 -> 2 -> 3`, rollback, uninstall, Skill replacement, cancellation, and journal recovery. It must set:

```yaml
env:
  CODEXBRIDGE_SOFTWARE_MANAGER_FAKE_HOST: "1"
  CODEXBRIDGE_SOFTWARE_MANAGER_TEST_ROOT: "${{ runner.temp }}\\codexbridge-software-manager"
```

The test fails if any target resolves outside that root and never calls a real installer, registry writer, shortcut writer, or installed application.

- [ ] **Step 5: Run the software-manager suite and Windows packaging smoke**

Run: `$env:CODEXBRIDGE_SOFTWARE_MANAGER_FAKE_HOST='1'; npm run test:software-manager; npm run package:win; npm run package:win:smoke; Remove-Item Env:CODEXBRIDGE_SOFTWARE_MANAGER_FAKE_HOST`

Expected: PASS in explicit fake-host mode. Separately run `npm run release:code-ready` and expect `catalog_trust_not_provisioned` until Task 14; this prevents an untrusted build from becoming release-ready.

- [ ] **Step 6: Commit package and CI coverage**

```powershell
git add scripts/package-windows.mjs scripts/package-content-policy.mjs scripts/smoke-packaged-windows.mjs scripts/release-preflight.mjs package.json .github/workflows/desktop-portable.yml tests/software-manager-package.test.js tests/software-manager-ci-transaction.test.js
git commit -m "Add software manager package and CI gates"
```

### Task 12: Isolated Catalog Publisher

**Files:**
- Create: `scripts/software-manager/publisher-config.mjs`
- Create: `scripts/software-manager/package-inspector.mjs`
- Create: `scripts/software-manager/catalog-builder.mjs`
- Create: `scripts/software-manager/publish-chatgpt.mjs`
- Create: `scripts/software-manager/publish-skills.mjs`
- Create: `tests/software-manager-publisher.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: shared schema from Task 1 and environment variables `CBI_SIGNING_KEY_FILE`, `CBI_PUBLIC_ROOT`, `CBI_PACKAGE_BASE_URL`.
- Produces: immutable versioned objects, `component-catalog.json`, and `component-catalog.json.sig` under a caller-supplied isolated staging root.

- [ ] **Step 1: Write failing publisher tests**

Generate ephemeral signing keys and fixture packages. Assert ChatGPT normalization to ZIP, exact entry/version/hash/size/max-path metadata, Skill ID/path policy, deterministic sorted catalog JSON, detached signature, immutable-name refusal, upload-order event log, and retention of current plus one fallback only:

```js
test("publisher writes package and signature before atomically replacing catalog", async () => {
  const result = await publishFixture();
  assert.deepEqual(result.events.slice(-3), ["package_verified", "signature_written", "catalog_replaced"]);
  verifyPublishedCatalog(result.publicRoot, result.publicKey);
});
```

- [ ] **Step 2: Run publisher tests and confirm failure**

Run: `node --test tests/software-manager-publisher.test.js`

Expected: FAIL on missing publisher modules.

- [ ] **Step 3: Implement isolated configuration and package inspection**

Configuration refuses `/opt/shanhai/codex-installer`, any path containing the old `install-test`, and any package base URL outside `/codexbridge-test/packages/`. ChatGPT publication accepts the user-supplied package only from an explicit local input path, verifies its executable/version, and writes a normalized immutable ZIP.

- [ ] **Step 4: Implement Skill publication and signed catalog replacement**

Each Skill must be a direct child with `SKILL.md`; reject links, duplicate IDs, traversal names, and files outside its root. Serialize with sorted keys and LF, sign exact bytes with RSA-SHA256, fsync, then rename the catalog last.

- [ ] **Step 5: Add manual publisher commands and run tests**

Add scripts:

```json
"software:publish:chatgpt": "node scripts/software-manager/publish-chatgpt.mjs",
"software:publish:skills": "node scripts/software-manager/publish-skills.mjs"
```

Run: `node --test tests/software-manager-publisher.test.js`

Expected: PASS entirely under temporary directories.

- [ ] **Step 6: Commit publisher tooling**

```powershell
git add scripts/software-manager package.json tests/software-manager-publisher.test.js
git commit -m "Add isolated software catalog publisher"
```

### Task 13: V2RayN and Git Synchronization

**Files:**
- Create: `scripts/software-manager/sync-v2rayn.mjs`
- Create: `scripts/software-manager/sync-git.mjs`
- Create: `scripts/software-manager/sync-components.mjs`
- Create: `tests/software-manager-sync.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes V2RayN page `https://v1.v2ai.top/doc/#/Windows/V2free`, package `https://v1.v2ai.top/ssr-download/v2rayn.7z`, and official Git for Windows release metadata.
- Produces: `inspectV2RayNRelease({ fetchImpl, archiveInspector })`, `inspectGitRelease({ fetchImpl })`, `syncComponents({ currentCatalog, publisher, sources })`.

- [ ] **Step 1: Write failing source parsing and unchanged-package tests**

Use recorded minimal HTML/JSON fixtures, not live internet. Assert V2RayN fixed URL is never used as version identity, internal executable version plus hash identifies a release, unchanged hash is no-op, Git selects only official x64 installer, missing Authenticode metadata refuses publication, and failed download leaves catalog unchanged:

```js
test("V2RayN fixed URL publishes only when inspected content changes", async () => {
  const result = await inspectV2RayNRelease({ fetchImpl: fixtureFetchSameHash, archiveInspector });
  assert.equal(result.action, "noop");
  assert.equal(result.reason, "content_unchanged");
});
```

- [ ] **Step 2: Run sync tests and confirm failure**

Run: `node --test tests/software-manager-sync.test.js`

Expected: FAIL because sync modules are absent.

- [ ] **Step 3: Implement V2RayN content inspection and immutable publication**

Download to an isolated `.part`, verify nonzero bounded size, inspect 7z entries and internal executable version, calculate SHA256, compare with catalog, and publish a versioned filename only when content changes.

- [ ] **Step 4: Implement official Git discovery and verification gates**

Use the official `git-for-windows/git` GitHub release endpoint reached from the Git for Windows release source, select `Git-*-64-bit.exe`, require HTTPS GitHub release asset origin, record version/size/hash, and require the Windows publication host's Authenticode result `Valid` before catalog mutation.

- [ ] **Step 5: Add the combined sync command and run tests**

Add:

```json
"software:sync": "node scripts/software-manager/sync-components.mjs"
```

Run: `node --test tests/software-manager-sync.test.js`

Expected: PASS from fixtures; live upstream success is not claimed.

- [ ] **Step 6: Commit sync tooling**

```powershell
git add scripts/software-manager/sync-v2rayn.mjs scripts/software-manager/sync-git.mjs scripts/software-manager/sync-components.mjs tests/software-manager-sync.test.js package.json
git commit -m "Add V2RayN and Git release synchronization"
```

### Task 14: New Test-Only Server Environment

**Files:**
- Create: `deploy/codexbridge-installer/README.md`
- Create: `deploy/codexbridge-installer/nginx-test-location.conf`
- Create: `deploy/codexbridge-installer/codexbridge-installer-sync.service`
- Create: `deploy/codexbridge-installer/codexbridge-installer-sync.timer`
- Create: `deploy/codexbridge-installer/install-test.sh`
- Create: `deploy/codexbridge-installer/verify-test.mjs`
- Modify: `desktop/software-manager/catalog-public-key.mjs`
- Create: `tests/software-manager-deploy-contract.test.js`
- Modify: `desktop/software-manager/catalog-trust.mjs`
- Modify: `scripts/release-preflight.mjs`

**Interfaces:**
- Deployment root: `/opt/shanhai/codexbridge-installer/`.
- Public test path: `/codexbridge-install-test/`.
- Object prefix: `/codexbridge-test/packages/`.
- Required secrets/config: root-owned environment file with `CBI_SIGNING_KEY_FILE`, `CBI_PUBLIC_ROOT`, `CBI_PACKAGE_BASE_URL`, COS destination, and optional authenticated GitHub token.

- [ ] **Step 1: Write failing deployment isolation tests**

Static tests must assert every new file uses only the new root/test path/object prefix, contains no old signing key, does not edit old units or locations, makes the private key unreadable to the web user, serves JSON/signature with no-store, serves immutable packages with long cache, and omits the future production location:

```js
test("deployment assets cannot target old installer trees", () => {
  for (const file of deployFiles()) {
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(text, /\/opt\/shanhai\/codex-installer|location\s+\/install(?:-test)?\//);
  }
});
```

- [ ] **Step 2: Run deployment contract tests and confirm failure**

Run: `node --test tests/software-manager-deploy-contract.test.js`

Expected: FAIL because deploy files do not exist.

- [ ] **Step 3: Implement idempotent test-environment deployment assets**

`install-test.sh` creates only exact new directories, installs only new named systemd units, validates nginx before reload, and exits if any resolved path escapes `/opt/shanhai/codexbridge-installer`. It never creates `/codexbridge-install/` and never invokes old installer scripts. Its key-generation branch creates a new RSA private key directly in a root-owned directory, mode `0600`, only when no key exists; it prints only the SPKI public key and SHA256 fingerprint.

- [ ] **Step 4: Implement read-only remote verification**

`verify-test.mjs` fetches catalog and signature, verifies the pinned public key, checks every immutable asset with HEAD and streamed SHA256, and outputs a JSON report with endpoint, version, size, hash, and timestamp. It performs no upload or mutation.

- [ ] **Step 5: Run deployment tests locally**

Run: `node --test tests/software-manager-deploy-contract.test.js && node --check deploy/codexbridge-installer/verify-test.mjs`

Expected: PASS without SSH or server mutation.

- [ ] **Step 6: Commit isolated deployment assets**

```powershell
git add deploy/codexbridge-installer tests/software-manager-deploy-contract.test.js
git commit -m "Add isolated software manager test deployment"
```

- [ ] **Step 7: Deploy only after code review and explicit execution checkpoint**

Before mutation, record read-only hashes/status for old `/install/`, `/install-test/`, old systemd units, and old nginx locations. Deploy only the new test environment, then rerun the same old-environment read-only checks and prove they are unchanged. Do not deploy the production endpoint.

Capture the generated SPKI public key and fingerprint from command output without copying the private key. Add the public key to `desktop/software-manager/catalog-public-key.mjs`, make `catalog-trust.mjs` use it by default outside fake-host tests, and make `release-preflight.mjs` require the exact committed fingerprint. Then run:

```powershell
node --test tests/software-manager-catalog.test.js tests/software-manager-deploy-contract.test.js
npm run release:code-ready
git add desktop/software-manager/catalog-public-key.mjs desktop/software-manager/catalog-trust.mjs scripts/release-preflight.mjs
git commit -m "Pin software catalog test signing key"
```

Expected: catalog/deploy tests and release gate PASS; the private key remains only on the isolated server.

### Task 15: Full Regression, Disposable Windows Acceptance, and Handoff

**Files:**
- Create: `docs/software-manager-test-environment.md`
- Create: `docs/software-manager-disposable-windows-acceptance.md`
- Modify: `docs/superpowers/specs/2026-08-07-codex-software-manager-design.md` only if implementation evidence requires a factual clarification approved by the user.

**Interfaces:**
- Consumes all prior tasks.
- Produces source/CI/package evidence, isolated test endpoint evidence, and a separately labeled real acceptance report.

- [ ] **Step 1: Run focused and complete local verification**

Run:

```powershell
npm run test:software-manager
npm run test:desktop
npm run test:router
npm run check:syntax
git diff --check
```

Expected: all PASS. If the complete `npm run check` is affordable in the current session, run it too and record the fresh test count.

- [ ] **Step 2: Run package and release gates**

Run:

```powershell
npm run package:win
npm run package:win:smoke
npm run release:code-ready
```

Expected: PASS. Describe this only as package/runtime smoke evidence.

- [ ] **Step 3: Verify CI on ephemeral Windows**

Push only after the user authorizes GitHub publication. Require the full workflow plus the fake-host software-manager transaction job to pass; download and inspect its JSON evidence artifact.

- [ ] **Step 4: Verify the isolated test endpoint**

Run the read-only verifier against `https://shanhaiyouling.com/codexbridge-install-test/`, confirm signatures, lengths, hashes, immutable package URLs, and old-environment unchanged evidence. Do not call `/codexbridge-install/`.

- [ ] **Step 5: Execute real acceptance only on a disposable Windows machine**

The acceptance checklist is exact: install selected ChatGPT/V2RayN/Git/Skills to default and custom roots; verify shortcut collision numbering; update each component through three fixture versions; verify current/previous retention; rollback ChatGPT, V2RayN, and managed Git; replace and uninstall one Skill; uninstall each program; verify `.codex`, V2RayN config, `.gitconfig`, SSH keys, credentials, and repositories remain. Also verify external ChatGPT/V2RayN are untouched and external Git has no rollback.

- [ ] **Step 6: Write evidence with truthful boundaries**

`docs/software-manager-test-environment.md` records endpoint, signing-key fingerprint, manifest hash, package hashes, CI run, and old-environment unchanged checks. `docs/software-manager-disposable-windows-acceptance.md` records machine identity, OS build, exact actions, versions, paths, screenshots, and pass/fail. If no disposable machine is available, write `真实验收尚未完成` and do not release.

- [ ] **Step 7: Final regression commit**

```powershell
git add docs/software-manager-test-environment.md docs/software-manager-disposable-windows-acceptance.md
git commit -m "Document software manager acceptance evidence"
```

## Execution Checkpoints

1. Tasks 1-10 may run locally because all tests are pure, fake-host, or temporary-directory based.
2. Task 11 may package locally but must not run a real installer.
3. Tasks 12-13 may run only with fixture inputs locally; live publication waits for signing and isolated-environment review.
4. Task 14 Step 7 is the first server mutation and requires an explicit checkpoint immediately before execution.
5. Task 15 Step 3 requires user authorization before GitHub push; Step 5 requires a disposable Windows machine.

## Completion Boundary

Implementation is code-complete only when Tasks 1-14 local/CI gates pass. It is release-ready only when the new test endpoint is verified, the old environments are proven unchanged, and Task 15 real disposable-Windows acceptance passes. Without that machine, the correct final status is `代码与模拟验证完成，真实验收尚未完成`.

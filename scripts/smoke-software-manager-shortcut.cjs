const { app, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');

app.whenReady().then(async () => {
  const sandbox = fs.mkdtempSync(path.join(process.env.CODEXBRIDGE_TEST_TMPDIR || app.getPath('temp'), 'cb-shortcut-'));
  const { authorizeDesktopPath } = await import('../desktop/software-manager/path-policy.mjs');
  const { createWin32FileApi } = await import('../desktop/software-manager/win32-file-api.mjs');
  const { createWindowsFileCapabilities } = await import('../desktop/software-manager/windows-file-capabilities.mjs');
  const { createWindowsHost } = await import('../desktop/software-manager/windows-host.mjs');
  const { createLazyShortcutFileApi } = await import('../desktop/software-manager/lazy-shortcut-file-api.mjs');
  const desktop = await authorizeDesktopPath({ getDesktopPath: () => sandbox, realpath: fs.promises.realpath, lstat: fs.promises.lstat });
  const nativeApi = createWin32FileApi({ platform: 'win32' });
  const files = createWindowsFileCapabilities({ platform: 'win32', nativeApi });
  const host = createWindowsHost({ platform: 'win32', electronShell: shell, execFile,
    shortcutFileApi: createLazyShortcutFileApi({ getDesktopCapability: async () => desktop, fileCapabilities: files }),
    getSystemDirectory: () => nativeApi.getSystemDirectory() });
  const target = process.execPath;
  const planned = await host.planShortcut({ name: 'ChatGPT', desktopPath: sandbox, targetPath: target });
  const recorded = await host.createShortcut(planned.plan);
  assert.equal(shell.readShortcutLink(recorded.path).target, target);
  assert.equal((await host.inspectRecordedShortcut(recorded)).kind, 'shortcut');
  assert.equal((await host.removeRecordedShortcut(recorded)).removed, true);
  assert.equal((await host.inspectRecordedShortcut(recorded)).kind, 'absent');
  fs.rmdirSync(sandbox);
  console.log('REAL_WINDOWS_SHORTCUT_SMOKE_PASS');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });

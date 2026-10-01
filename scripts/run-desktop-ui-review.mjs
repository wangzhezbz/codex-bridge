import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import electronPath from 'electron';
import { createSourceDesktopSmokeFixture, cleanupSourceDesktopSmokeFixture } from './desktop-smoke-fixture.mjs';

const fixture = createSourceDesktopSmokeFixture();
const child = spawn(electronPath, ['scripts/desktop-ui-review.cjs'], {
  env: {...process.env, ...fixture.env, CODEXBRIDGE_DESKTOP_SMOKE:'1',
    CODEXBRIDGE_DESKTOP_SMOKE_SOFTWARE_MANAGER:'1', CODEXBRIDGE_DESKTOP_SMOKE_SOFTWARE_MANAGER_OFFLINE:'1',
    CODEXBRIDGE_DESKTOP_SMOKE_START_ROUTER:'0',
    CODEXBRIDGE_UI_REVIEW_OUTPUT:path.resolve(process.argv[2] || '.audit-artifacts/ui-redesign')},
  windowsHide:true, stdio:'inherit',
});
// The matrix now includes a real atomic mode recovery in addition to private-file saves.
// Individual UI waits remain limited to 20 seconds; this is only the total suite budget.
const timer = setTimeout(() => { console.error('UI review exceeded 180 seconds'); child.kill(); }, 180_000);
child.once('error', error => { console.error(error); clearTimeout(timer); process.exitCode = 1; });
child.once('exit', code => {
  clearTimeout(timer);
  try {
    // Visiting the service page creates this one known file in our disposable profile.
    const serviceConfig = path.join(fixture.dataDir, 'config', 'double-quota.json');
    if (fs.existsSync(serviceConfig)) fs.unlinkSync(serviceConfig);
    cleanupSourceDesktopSmokeFixture(fixture);
  }
  catch (error) { console.error(error); process.exitCode = 1; }
  if (code !== 0) process.exitCode = code || 1;
});

# Release Checklist

Before tagging a CodexBridge release:

0. Read `docs/pre-release-handoff.md` and confirm the current release scope, user-facing changelog, real-environment acceptance items, and "do not repeat" list are still accurate.
1. Run `npm run release:preflight`.
2. Run `npm run release:code-ready` while real Router/provider/installer evidence is still unavailable. This command still prints those gaps, but it exits non-zero only when `codeReady.codeOrConfigBlockingItemIds` has repository code/config work. Its JSON also exposes `codeReady.ignoredRealEvidenceItemIds` and `codeReady.ignoredLocalSetupItemIds`, so testers can take over real data checks without making local code progress look unfinished.
3. Start Router with the release candidate config, then run `npm run release:preflight` again so Router and route-health checks cover the real running process.
4. Run `npm run check`.
5. Run `npm run desktop:smoke`.
6. Run `npm run package:win`.
7. Run `npm run package:win:smoke`.
8. Run `npm run package:win:artifacts` on a Windows machine with NSIS installed, or let the GitHub Actions Windows job run the same command.
9. Run `node scripts/release-preflight.mjs --platform win32 --arch x64 --release-dir dist-artifacts` after Windows artifacts are created; this checks expected names, non-empty files, and EXE/ZIP file headers.
10. In `dist-artifacts`, only keep valid Windows artifacts named `CodexBridge-Windows-x64-Setup.exe` and `CodexBridge-Windows-x64-Portable.zip`; Windows 发布目录只保留 `CodexBridge-Windows-x64-Setup.exe` 和 `CodexBridge-Windows-x64-Portable.zip` 这两个非空且文件头正确的文件，remove old or version-suffixed package names before publishing.
11. After the real Router, provider keys, image provider, capability providers, and Windows artifacts are ready, run `node scripts/release-preflight.mjs --platform win32 --arch x64 --release-dir dist-artifacts --write-acceptance-report release-acceptance.json --write-gate-report release-gate.json`. This writes a machine-readable acceptance evidence file from the current Router probe, fresh provider test records, and valid Windows artifacts, plus a complete release gate report.
12. If the real acceptance work was performed outside this command, save a JSON evidence file and pass it with `--acceptance-report <path>`. This report should contain successful `router`, `imageProvider` or `imageProviders`, `capabilityProvider` or `capabilityProviders`, and `windowsInstaller` sections; it is evidence for the release gate, not a replacement for doing the real checks.
13. If you are validating from the desktop app, open the preflight/health page and use `保存门禁报告` after selecting the release artifact directory. The saved JSON should be kept with the release notes as the desktop-side evidence for the same gate.
14. Run `npm run release:gate -- --platform win32 --arch x64 --release-dir dist-artifacts --acceptance-report release-acceptance.json --write-gate-report release-gate.json` after the evidence file is ready; this is the final local release gate and is shorthand for `node scripts/release-preflight.mjs --strict-warnings ...`. The `real_environment_acceptance` item must show that the real Router, real image provider test, real capability provider or local bridge test, and real installer artifacts have evidence; any warning must be handled or intentionally documented before tagging.
15. For machine checks, `node scripts/release-preflight.mjs --json --strict-warnings ...` exposes `releaseGate.reason`, `releaseGate.failureItemIds`, `releaseGate.warningItemIds`, `releaseGate.blockingItemIds`, `releaseGate.realEvidenceBlockingItemIds`, `releaseGate.localSetupBlockingItemIds`, `releaseGate.codeOrConfigBlockingItemIds`, `acceptanceReport.path/written/ok` when an acceptance report is read or written, and `gateReport.path/written/ok` when the full gate report is written. Treat `realEvidenceBlockingItemIds` as real tester evidence gaps, `localSetupBlockingItemIds` as current machine setup/runtime tasks, and `codeOrConfigBlockingItemIds` as repo work that must be fixed before tagging; `strict_warnings` means WARN items, not FAIL items, blocked the release.
16. In GitHub Actions, keep `windows-release-gate.json` and `macos-*-release-gate.json` as CI artifacts for diagnostics, but do not attach them to the public GitHub Release. Public release assets should stay limited to the Windows installer, Windows portable zip, and macOS portable zips.
17. Confirm `docs/model-regression-matrix.md` still reflects the route behavior being released.
18. Confirm all built-in adapter profile tests pass.
19. Confirm all local provider-category smoke tests pass.
20. Confirm `git status --short --branch` is clean before tagging.
21. Push `main`.
22. Create and push the version tag.
23. Wait for GitHub Actions release build success.
24. Confirm `/releases/latest` points to the new version.

Minimal acceptance report example:

```json
{
  "ok": true,
  "checkedAt": "2026-07-05T08:00:00.000Z",
  "router": {
    "ok": true,
    "detail": "real router health passed",
    "models": ["gpt-5.5"]
  },
  "imageProvider": {
    "ok": true,
    "provider": "SiliconFlow Kolors",
    "localPath": "C:\\Users\\Administrator\\Pictures\\CodexBridge\\sample.png",
    "durationMs": 1200
  },
  "capabilityProvider": {
    "ok": true,
    "provider": "Local Chrome Bridge",
    "capability": "browser",
    "durationMs": 300
  },
  "windowsInstaller": {
    "ok": true,
    "setupExe": "CodexBridge-Windows-x64-Setup.exe",
    "portableZip": "CodexBridge-Windows-x64-Portable.zip"
  }
}
```

Do not tag a release when any built-in provider category has a known compatibility failure.

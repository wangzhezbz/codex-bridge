import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const latestPortableUrl =
  "https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Portable.zip";
const latestInstallerUrl =
  "https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Setup.exe";
const latestMacArm64Url =
  "https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-arm64-Portable.zip";
const latestMacX64Url =
  "https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-x64-Portable.zip";

test("public docs use the stable latest Windows download link", () => {
  for (const file of ["README.md", path.join("docs", "releases.md"), path.join("docs", "windows-setup.md")]) {
    const text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    assert.match(text, new RegExp(escapeRegExp(latestInstallerUrl)), `${file} should link latest installer build`);
    assert.match(text, new RegExp(escapeRegExp(latestPortableUrl)), `${file} should link latest portable build`);
    assert.doesNotMatch(text, /CodexBridge-windows-portable/i, `${file} should not use the old package name`);
  }

  const portableDoc = fs.readFileSync(path.join(process.cwd(), "docs", "windows-portable.md"), "utf8");
  assert.match(portableDoc, new RegExp(escapeRegExp(latestPortableUrl)));
  assert.doesNotMatch(portableDoc, /CodexBridge-windows-portable/i);
});

test("public docs use stable latest macOS download links", () => {
  for (const file of ["README.md", path.join("docs", "macos-portable.md"), path.join("docs", "releases.md")]) {
    const text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    assert.match(text, new RegExp(escapeRegExp(latestMacArm64Url)), `${file} should link latest macOS arm64 build`);
    assert.match(text, new RegExp(escapeRegExp(latestMacX64Url)), `${file} should link latest macOS x64 build`);
  }
});

test("user-facing docs separate Win users and Mac users", () => {
  for (const file of [
    "README.md",
    path.join("docs", "windows-portable.md"),
    path.join("docs", "macos-portable.md"),
    path.join("docs", "releases.md"),
    path.join("docs", "windows-setup.md"),
  ]) {
    const text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    assert.match(text, /Win 用户|Win users|Windows/, `${file} should name Win or Windows users`);
    assert.match(text, /Mac 用户|Mac users|Mac/, `${file} should name Mac users`);
    assert.doesNotMatch(text, /普通用户|Normal users/i, `${file} should not say normal users`);
    assert.doesNotMatch(text, /高级用户|Advanced users/i, `${file} should not say advanced users`);
  }
});

test("top-level download sections use simple platform labels", () => {
  for (const file of ["README.md", path.join("docs", "releases.md")]) {
    const text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    assert.match(text, /- Windows installer: \[CodexBridge-Windows-x64-Setup\.exe\]/, `${file} should use a simple Windows installer label`);
    assert.match(text, /- Windows portable fallback: \[CodexBridge-Windows-x64-Portable\.zip\]/, `${file} should use a simple Windows portable fallback label`);
    assert.match(text, /- Mac M series: \[CodexBridge-macOS-arm64-Portable\.zip\]/, `${file} should use a simple Mac M label`);
    assert.match(text, /- Mac Intel: \[CodexBridge-macOS-x64-Portable\.zip\]/, `${file} should use a simple Mac Intel label`);
    assert.doesNotMatch(text, /Win users\s*\/\s*Win/i, `${file} should not duplicate Win labels`);
    assert.doesNotMatch(text, /Mac users\s*\/\s*Mac/i, `${file} should not duplicate Mac labels`);
  }
});

test("Windows user docs recommend the installer before the portable fallback", () => {
  const readDoc = (file) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const readme = readDoc("README.md");
  const setupDoc = readDoc(path.join("docs", "windows-setup.md"));
  const portableDoc = readDoc(path.join("docs", "windows-portable.md"));

  for (const [file, text] of [
    ["README.md", readme],
    ["docs/windows-setup.md", setupDoc],
  ]) {
    const setupIndex = text.indexOf("CodexBridge-Windows-x64-Setup.exe");
    const portableIndex = text.indexOf("CodexBridge-Windows-x64-Portable.zip");
    assert.ok(setupIndex >= 0, `${file} should link the Windows installer`);
    assert.ok(portableIndex >= 0, `${file} should still link the portable fallback`);
    assert.ok(
      setupIndex < portableIndex,
      `${file} should present the installer before the portable fallback`,
    );
    assert.match(text, /Windows installer|Windows 安装版/, `${file} should name the installer path clearly`);
    assert.match(text, /portable fallback|便携版备用|免安装备用/, `${file} should name portable as fallback`);
  }

  assert.doesNotMatch(readme, /Windows 下下载 Windows 免安装包/);
  assert.doesNotMatch(readme, /Win 和 Mac 免安装包，不再要求用户手动安装 Node\.js/);
  assert.match(readme, /On Windows, download the Windows installer and run it/);
  assert.match(readme, /Windows 下下载 Windows 安装版并运行/);
  assert.match(portableDoc, /portable fallback|便携版备用|免安装备用/);
  assert.doesNotMatch(portableDoc, /customer-facing delivery is the Windows portable package/i);
  assert.doesNotMatch(portableDoc, /正式交付方式是下载 GitHub Release 里的 Windows 免安装包/);
});

test("portable docs explain stable user data storage", () => {
  const text = fs.readFileSync(
    path.join(process.cwd(), "docs", "windows-portable.md"),
    "utf8",
  );

  assert.match(text, /%APPDATA%\\CodexBridge/);
  assert.match(text, /will not overwrite newly saved settings or API keys/);
});

test("macOS portable docs explain stable user data storage and first launch", () => {
  const text = fs.readFileSync(
    path.join(process.cwd(), "docs", "macos-portable.md"),
    "utf8",
  );

  assert.match(text, /~\/Library\/Application Support\/CodexBridge/);
  assert.match(text, /right-click/);
  assert.match(text, /Control-click/);
});

test("goal coverage audit keeps long-running roadmap status explicit", () => {
  const text = fs.readFileSync(
    path.join(process.cwd(), "docs", "goal-coverage-audit.md"),
    "utf8",
  );

  for (const heading of [
    "第一阶段：图片生成代理",
    "第二阶段：代理底座和发布体检",
    "第三阶段：能力扩展",
    "第四阶段：智能路由",
    "第五阶段：用户资产",
  ]) {
    assert.match(text, new RegExp(escapeRegExp(heading)));
  }

  assert.match(text, /自动选模型：已实现，默认关闭/);
  assert.match(text, /失败自动切换：已实现，默认关闭/);
  assert.match(text, /不把真实 Key、真实 Router、真实安装器证据当作仓库代码阻塞/);
  assert.match(text, /435\/435 tests/);
  assert.match(text, /当前代码证据/);
  assert.match(text, /真实环境验收/);
  assert.match(text, /下一步/);
  assert.match(text, /不会自动写回 Codex Desktop 本地会话数据库/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

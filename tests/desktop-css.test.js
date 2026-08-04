import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const styles = fs.readFileSync(
  path.join(rootDir, "desktop", "renderer", "styles.css"),
  "utf8",
);

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] || "";
}

test("desktop main column is the only vertical scroll container", () => {
  const main = cssBlock(".main");

  assert.match(main, /min-height:\s*0;/);
  assert.match(main, /overflow-y:\s*auto;/);
  assert.match(main, /overflow-x:\s*hidden;/);
  assert.match(main, /-webkit-overflow-scrolling:\s*touch;/);
});

test("sidebar reserves fixed brand and action rows around a shrinkable navigation row", () => {
  const sidebar = cssBlock(".sidebar");
  const navList = cssBlock(".nav-list");

  assert.match(sidebar, /display:\s*grid;/);
  assert.match(sidebar, /grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto;/);
  assert.match(navList, /min-height:\s*0;/);
  assert.match(navList, /align-content:\s*start;/);
});

test("short desktop heights compact every sidebar row and keep all footer actions visible", () => {
  const compactStart = styles.indexOf("@media (max-height: 820px)");
  assert.notEqual(compactStart, -1);
  const compact = styles.slice(compactStart);

  assert.match(compact, /\.sidebar\s*{[\s\S]*?padding:\s*10px 12px;/);
  assert.match(compact, /\.brand-mark\s*{[\s\S]*?width:\s*36px;[\s\S]*?height:\s*36px;/);
  assert.match(compact, /\.nav-list\s*{[\s\S]*?gap:\s*2px;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(compact, /\.nav-item\s*{[\s\S]*?min-height:\s*32px;/);
  assert.match(compact, /\.sidebar-actions\s*{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
  assert.match(compact, /\.sidebar-actions \.app-version,[\s\S]*?#checkUpdates\s*{[\s\S]*?grid-column:\s*1 \/ -1;/);
  assert.match(compact, /\.sidebar-actions \.ghost-button\s*{[\s\S]*?min-height:\s*32px;/);
});

test("model pool does not trap scrolling before the custom form", () => {
  const modelPool = cssBlock(".model-pool");
  const modelGroup = cssBlock(".model-group");
  const customForm = cssBlock(".custom-form");

  assert.doesNotMatch(modelPool, /max-height:/);
  assert.doesNotMatch(modelGroup, /max-height:/);
  assert.doesNotMatch(customForm, /max-height:/);
  assert.match(modelPool, /overflow:\s*visible;/);
});

test("model context inline label is vertically centered", () => {
  const contextLabel = cssBlock(".model-context-inline span");

  assert.match(contextLabel, /display:\s*flex;/);
  assert.match(contextLabel, /align-items:\s*center;/);
  assert.match(contextLabel, /height:\s*32px;/);
  assert.match(contextLabel, /margin:\s*0;/);
});

test("double quota panels keep the same vertical gap above and below their grid", () => {
  const doubleQuotaGrid = cssBlock(".double-quota-grid");

  assert.match(doubleQuotaGrid, /margin:\s*16px 0;/);
});

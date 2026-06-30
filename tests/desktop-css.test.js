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

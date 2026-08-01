import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { formatRendererConsoleError } = require("../desktop/renderer-console-message.cjs");

test("renderer console formatter records warning and error details from the current Electron event", () => {
  assert.equal(
    formatRendererConsoleError({
      level: "warning",
      message: "renderer warning",
      sourceId: "app://renderer/app.js",
      lineNumber: 42,
    }),
    "Renderer console error: renderer warning (app://renderer/app.js:42)",
  );
  assert.equal(
    formatRendererConsoleError({
      level: "error",
      message: "renderer error",
      sourceId: "app://renderer/app.js",
      lineNumber: 43,
    }),
    "Renderer console error: renderer error (app://renderer/app.js:43)",
  );
});

test("renderer console formatter ignores debug and info messages", () => {
  assert.equal(formatRendererConsoleError({ level: "debug", message: "debug" }), null);
  assert.equal(formatRendererConsoleError({ level: "info", message: "info" }), null);
});

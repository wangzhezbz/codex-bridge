import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { classifyRouterProcessOutput } = require("../desktop/router-start-diagnostics.cjs");

test("Router process diagnostics classify only bounded actionable startup failures", () => {
  assert.equal(
    classifyRouterProcessOutput("Error: listen EADDRINUSE: address already in use 127.0.0.1:15722"),
    "router_port_in_use",
  );
  assert.equal(
    classifyRouterProcessOutput("Error: listen EACCES: permission denied 127.0.0.1:15722"),
    "router_port_permission_denied",
  );
  assert.equal(
    classifyRouterProcessOutput("SyntaxError: Unexpected token in JSON at position 44"),
    "router_config_invalid",
  );
  assert.equal(
    classifyRouterProcessOutput("C:\\secret\\router.config.json sk-secret-value"),
    "",
  );
  assert.equal(classifyRouterProcessOutput({ toString() { throw new Error("no coercion"); } }), "");
});

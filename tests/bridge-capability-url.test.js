import assert from "node:assert/strict";
import test from "node:test";

import { normalizeBridgeHttpUrl } from "../src/bridge-capability-url.js";

test("bridge capability URLs preserve canonical HTTP and HTTPS inputs", () => {
  const cases = [
    ["https://example.com/docs?q=1#top", "https://example.com/docs?q=1#top"],
    ["HTTP://EXAMPLE.COM:80/a", "http://example.com/a"],
    ["https://[::1]:8443/status", "https://[::1]:8443/status"],
  ];

  for (const [input, expected] of cases) {
    assert.equal(normalizeBridgeHttpUrl(input), expected, input);
  }
});

test("bridge capability URLs promote safe bare hosts to HTTPS", () => {
  const cases = [
    ["docs.example.com/path?q=1", "https://docs.example.com/path?q=1"],
    ["example.com", "https://example.com/"],
    ["localhost", "https://localhost/"],
    ["127.0.0.1:8080/status", "https://127.0.0.1:8080/status"],
  ];

  for (const [input, expected] of cases) {
    assert.equal(normalizeBridgeHttpUrl(input), expected, input);
  }
});

test("bridge capability URLs reject unsafe schemes, credentials, and separators", () => {
  const rejected = [
    "",
    "   ",
    "file:///tmp/secret.txt",
    "javascript:alert(1)",
    "//example.com/path",
    "/relative/path",
    "https://user@example.com/private",
    "https://example.com/a b",
    "https:\\example.com\\private",
    "example.com\\private",
    "https://example.com/path\nnext",
  ];

  for (const input of rejected) {
    assert.equal(normalizeBridgeHttpUrl(input), "", JSON.stringify(input));
  }
});

test("bridge capability URLs reject malformed bare hosts", () => {
  const rejected = [
    "example",
    "bad..example.com",
    "-bad.example.com",
    "bad-.example.com",
    "localhost:3000/health",
    "example.com:99999/path",
    "999.1.1.1/path",
  ];

  for (const input of rejected) {
    assert.equal(normalizeBridgeHttpUrl(input), "", input);
  }
});

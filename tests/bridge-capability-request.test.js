import assert from "node:assert/strict";
import test from "node:test";

import { parseBridgeCapabilityToolCall } from "../src/bridge-capability-request.js";

function parseArguments(args) {
  return parseBridgeCapabilityToolCall({
    id: "call_test",
    function: {
      name: "codexbridge_capability",
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    },
  });
}

test("bridge capability requests reject malformed and non-object arguments", () => {
  const toolCalls = [
    { function: { arguments: "not json" } },
    { function: { arguments: "[]" } },
    { function: { arguments: "null" } },
    { arguments: 42 },
  ];

  for (const toolCall of toolCalls) {
    const parsed = parseBridgeCapabilityToolCall(toolCall);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error.message, /JSON object/);
  }
});

test("bridge capability requests normalize browser read and open actions", () => {
  const read = parseArguments({
    capability: " Browser ",
    provider_id: " local-browser ",
    input: { action: " READ_URL ", url: "docs.example.com/path?q=1" },
  });
  assert.deepEqual(read, {
    ok: true,
    request: {
      capability: "browser",
      providerId: "local-browser",
      input: {
        action: "read_url",
        url: "https://docs.example.com/path?q=1",
      },
    },
  });

  const open = parseArguments({
    capability: "browser",
    action: "open_url",
    url: "https://example.com/app",
  });
  assert.deepEqual(open.request, {
    capability: "browser",
    providerId: "",
    input: {
      action: "open_url",
      url: "https://example.com/app",
    },
  });
});

test("bridge capability requests reject unsafe browser URLs", () => {
  for (const action of ["read_url", "open_url"]) {
    const parsed = parseArguments({
      capability: "browser",
      action,
      url: "file:///C:/secret.txt",
    });
    assert.equal(parsed.ok, false);
    assert.match(parsed.error.message, new RegExp(`browser/${action}`));
  }
});

test("bridge capability requests normalize controlled computer actions", () => {
  const list = parseArguments({
    capability: "computer_use",
    action: "list_apps",
    providerId: "desktop-computer",
  });
  assert.deepEqual(list.request, {
    capability: "computer_use",
    providerId: "desktop-computer",
    input: { action: "list_apps" },
  });

  const open = parseArguments({
    capability: "computer_use",
    action: "open_app",
    application: " Calculator ",
  });
  assert.equal(open.request.input.action, "open_app");
  assert.equal(open.request.input.app, "Calculator");

  const screenshot = parseArguments({
    capability: "computer_use",
    action: "screenshot_desktop",
    display_id: " display-2 ",
  });
  assert.deepEqual(screenshot.request.input, {
    action: "screenshot_desktop",
    displayId: "display-2",
  });
});

test("bridge capability requests reject missing apps and unsupported computer actions", () => {
  const missingApp = parseArguments({ capability: "computer_use", action: "open_app" });
  assert.equal(missingApp.ok, false);
  assert.match(missingApp.error.message, /allowlisted app name/);

  const click = parseArguments({ capability: "computer_use", action: "click", input: { x: 1, y: 2 } });
  assert.equal(click.ok, false);
  assert.ok(click.error instanceof Error);
});

test("bridge capability requests normalize search, screenshot, and OCR inputs", () => {
  const search = parseArguments({
    capability: "web_search",
    action: "search",
    query: "  CodexBridge security  ",
  });
  assert.deepEqual(search.request.input, {
    action: "search",
    query: "CodexBridge security",
  });

  const screenshot = parseArguments({
    capability: "webpage_screenshot",
    action: "screenshot_url",
    input: { url: "example.com/page" },
  });
  assert.deepEqual(screenshot.request.input, {
    action: "screenshot_url",
    url: "https://example.com/page",
  });

  const ocr = parseArguments({
    capability: "ocr",
    action: "extract_text",
    input: { image_url: "images.example.com/scan.png" },
  });
  assert.deepEqual(ocr.request.input, {
    action: "extract_text",
    image_url: "images.example.com/scan.png",
    imageUrl: "https://images.example.com/scan.png",
  });
});

test("bridge capability requests normalize remote and local file inputs", () => {
  const remote = parseArguments({
    capability: "file_processing",
    action: "extract_text",
    provider_id: "remote-file",
    input: { file_url: "files.example.com/report.txt" },
  });
  assert.deepEqual(remote.request, {
    capability: "file_processing",
    providerId: "remote-file",
    input: {
      action: "extract_text",
      file_url: "files.example.com/report.txt",
      fileUrl: "https://files.example.com/report.txt",
    },
  });

  const local = parseArguments({
    capability: "file_processing",
    action: "inspect_file",
    providerId: "local-text",
    input: { local_path: " C:\\work\\notes.txt " },
  });
  assert.deepEqual(local.request, {
    capability: "file_processing",
    providerId: "local-text",
    input: {
      action: "inspect_file",
      local_path: " C:\\work\\notes.txt ",
      path: "C:\\work\\notes.txt",
    },
  });
});

test("bridge capability requests reject invalid or missing file sources", () => {
  const invalid = parseArguments({
    capability: "file_processing",
    action: "extract_text",
    fileUrl: "file:///C:/secret.txt",
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error.message, /only accepts http\/https file URLs/);

  const missing = parseArguments({
    capability: "file_processing",
    action: "inspect_file",
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error.message, /explicit local file path/);
});

test("bridge capability requests normalize speech and video prompts", () => {
  const speech = parseArguments({
    capability: "speech",
    action: "synthesize",
    input: { prompt: "  Read this aloud  " },
  });
  assert.equal(speech.request.input.action, "synthesize");
  assert.equal(speech.request.input.text, "Read this aloud");

  const video = parseArguments({
    capability: "video",
    action: "generate",
    text: "  A bridge at sunrise  ",
  });
  assert.deepEqual(video.request.input, {
    action: "generate",
    prompt: "A bridge at sunrise",
  });
});

test("bridge capability requests reject empty required text and unknown actions", () => {
  const cases = [
    { capability: "web_search", action: "search", query: "   " },
    { capability: "speech", action: "synthesize", text: "" },
    { capability: "video", action: "generate", prompt: "" },
    { capability: "browser", action: "download", url: "https://example.com/file" },
    { capability: "unknown", action: "run" },
  ];

  for (const args of cases) {
    const parsed = parseArguments(args);
    assert.equal(parsed.ok, false, `${args.capability}/${args.action}`);
    assert.ok(parsed.error instanceof Error);
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  isPublicOpenAiApiBaseUrl,
  responsesBaseUrlForRoute,
} from "../src/responses-upstream-url.js";

test("public OpenAI API detection accepts only the exact API hostname", () => {
  assert.equal(isPublicOpenAiApiBaseUrl("https://api.openai.com/v1"), true);
  assert.equal(isPublicOpenAiApiBaseUrl("https://API.OPENAI.COM/v1/responses"), true);
  assert.equal(isPublicOpenAiApiBaseUrl("https://api.openai.com.evil.example/v1"), false);
  assert.equal(isPublicOpenAiApiBaseUrl("https://chatgpt.com/backend-api/codex"), false);
  assert.equal(isPublicOpenAiApiBaseUrl("not a URL"), false);
});

test("Codex subscription routes use the default ChatGPT Codex backend for public OpenAI URLs", () => {
  const originalBackend = process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL;
  try {
    delete process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL;
    assert.equal(
      responsesBaseUrlForRoute({
        authMode: "codex_openai",
        baseUrl: "https://api.openai.com/v1",
      }),
      "https://chatgpt.com/backend-api/codex",
    );
  } finally {
    if (originalBackend === undefined) {
      delete process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL;
    } else {
      process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL = originalBackend;
    }
  }
});

test("Codex subscription routes honor the explicit ChatGPT backend override", () => {
  const originalBackend = process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL;
  try {
    process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL = "http://127.0.0.1:4567/backend-api/codex";
    assert.equal(
      responsesBaseUrlForRoute({
        authMode: "codex_openai",
        baseUrl: "https://api.openai.com/v1",
      }),
      "http://127.0.0.1:4567/backend-api/codex",
    );
  } finally {
    if (originalBackend === undefined) {
      delete process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL;
    } else {
      process.env.CODEXBRIDGE_CHATGPT_CODEX_BASE_URL = originalBackend;
    }
  }
});

test("API-key, custom Codex, and malformed base URLs remain unchanged", () => {
  assert.equal(
    responsesBaseUrlForRoute({
      authMode: "api_key",
      baseUrl: "https://api.openai.com/v1",
    }),
    "https://api.openai.com/v1",
  );
  assert.equal(
    responsesBaseUrlForRoute({
      authMode: "codex_openai",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    }),
    "https://chatgpt.com/backend-api/codex",
  );
  assert.equal(
    responsesBaseUrlForRoute({
      authMode: "codex_openai",
      baseUrl: "https://custom.example/v1",
    }),
    "https://custom.example/v1",
  );
  assert.equal(
    responsesBaseUrlForRoute({ authMode: "codex_openai", baseUrl: "not a URL" }),
    "not a URL",
  );
});

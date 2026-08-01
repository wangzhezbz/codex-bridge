import assert from "node:assert/strict";
import test from "node:test";

import { bridgeCapabilityToolContent } from "../src/bridge-capability-result.js";

test("bridge capability tool content preserves normalized response metadata", () => {
  const content = JSON.parse(bridgeCapabilityToolContent({
    handled: true,
    response: {
      capability: "web_search",
      providerId: "search-1",
      providerName: "Search One",
      output_text: "Bridge answer",
      localPath: "C:\\tmp\\answer.json",
      mimeType: "application/json",
      sourceUrl: "https://example.com/source",
      data: {
        action: "search",
        query: "codex bridge",
        file_name: "answer.json",
        image_url: "https://example.com/image.png",
        speech_url: "https://example.com/audio.mp3",
        video_url: "https://example.com/video.mp4",
        local_path: "C:\\tmp\\stale.json",
        mime_type: "text/plain",
        source_url: "https://example.com/stale",
        text: "raw result",
        prompt: "find bridge",
        title: "Result title",
        status: "complete",
        contentType: "application/vnd.test",
        summary: "summary answer",
        sources: ["s1", "s2", "s3", "s4", "s5", "s6"],
        excerpt: "short excerpt",
        truncated: true,
      },
    },
  }));

  assert.deepEqual(content, {
    ok: true,
    capability: "web_search",
    providerId: "search-1",
    providerName: "Search One",
    output_text: "Bridge answer",
    data: {
      action: "search",
      url: "",
      query: "codex bridge",
      fileUrl: "",
      fileName: "answer.json",
      imageUrl: "https://example.com/image.png",
      audioUrl: "https://example.com/audio.mp3",
      videoUrl: "https://example.com/video.mp4",
      localPath: "C:\\tmp\\answer.json",
      mimeType: "application/json",
      sourceUrl: "https://example.com/source",
      text: "raw result",
      prompt: "find bridge",
      title: "Result title",
      status: "complete",
      contentType: "application/vnd.test",
      answer: "summary answer",
      sources: ["s1", "s2", "s3", "s4", "s5"],
      excerpt: "short excerpt",
      truncated: true,
    },
  });
});

test("bridge capability tool content falls back to outer upstream results", () => {
  const content = JSON.parse(bridgeCapabilityToolContent({
    handled: true,
    capability: "speech",
    providerId: "voice-1",
    providerName: "Voice One",
    localPath: "C:\\tmp\\voice.mp3",
    mimeType: "audio/mpeg",
    sourceUrl: "https://example.com/jobs/voice-1",
    upstream: {
      action: "synthesize",
      text: "hello from bridge",
      speech_url: "https://example.com/voice.mp3",
    },
  }));

  assert.equal(content.ok, true);
  assert.equal(content.capability, "speech");
  assert.equal(content.output_text, "hello from bridge");
  assert.equal(content.data.action, "synthesize");
  assert.equal(content.data.audioUrl, "https://example.com/voice.mp3");
  assert.equal(content.data.localPath, "C:\\tmp\\voice.mp3");
  assert.equal(content.data.mimeType, "audio/mpeg");
  assert.equal(content.data.sourceUrl, "https://example.com/jobs/voice-1");
});

test("bridge capability tool content reports only handled non-skipped successes", () => {
  const cases = [
    [{ handled: true }, true],
    [{ handled: false }, false],
    [{ handled: true, skipped: true }, false],
    [{ handled: true, failed: true }, false],
  ];

  for (const [result, expected] of cases) {
    assert.equal(JSON.parse(bridgeCapabilityToolContent(result)).ok, expected);
  }
});

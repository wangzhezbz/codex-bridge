import assert from "node:assert/strict";
import test from "node:test";

class TestUpstreamHttpError extends Error {
  constructor(statusCode, bodyText = "") {
    super(`Upstream returned HTTP ${statusCode}`);
    this.statusCode = statusCode;
    this.bodyText = bodyText;
  }
}

test("image rejection policy retries eligible media errors", async () => {
  const { createUpstreamImageRetryPolicy } = await import(
    "../src/upstream-image-retry-policy.js"
  );
  const { shouldRetryChatWithoutImages } = createUpstreamImageRetryPolicy({
    UpstreamHttpError: TestUpstreamHttpError,
  });

  const retry = shouldRetryChatWithoutImages(
    new TestUpstreamHttpError(415, "unsupported media image_url"),
    {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }],
        },
      ],
    },
  );

  assert.equal(retry, true);
});

test("image rejection policy refuses unrelated or rate-limited failures", async () => {
  const { createUpstreamImageRetryPolicy } = await import(
    "../src/upstream-image-retry-policy.js"
  );
  const { shouldRetryChatWithoutImages } = createUpstreamImageRetryPolicy({
    UpstreamHttpError: TestUpstreamHttpError,
  });
  const imageBody = {
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }],
      },
    ],
  };

  assert.equal(
    shouldRetryChatWithoutImages(
      new TestUpstreamHttpError(429, "rate limit"),
      imageBody,
    ),
    false,
  );
  assert.equal(
    shouldRetryChatWithoutImages(
      new TestUpstreamHttpError(400, "invalid temperature"),
      imageBody,
    ),
    false,
  );
  assert.equal(
    shouldRetryChatWithoutImages(
      new TestUpstreamHttpError(400, "image is unsupported"),
      { messages: [{ role: "user", content: "text only" }] },
    ),
    false,
  );
});

test("image sanitization replaces image parts with stable text placeholders", async () => {
  const { chatBodyWithoutImages } = await import(
    "../src/upstream-image-retry-policy.js"
  );

  const sanitized = chatBodyWithoutImages({
    model: "example-model",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
          { type: "input_image", image_url: "data:image/png;base64,def" },
        ],
      },
    ],
  });

  assert.deepEqual(sanitized, {
    model: "example-model",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          {
            type: "text",
            text: "[image input omitted because upstream rejected image content]",
          },
          {
            type: "text",
            text: "[image input omitted because upstream rejected image content]",
          },
        ],
      },
    ],
  });
});

test("image sanitization leaves the source request unchanged", async () => {
  const { chatBodyWithoutImages } = await import(
    "../src/upstream-image-retry-policy.js"
  );
  const source = {
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }],
      },
    ],
  };

  chatBodyWithoutImages(source);

  assert.deepEqual(source, {
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }],
      },
    ],
  });
});

test("image rejection fallback chat preserves the provider label and retry detail", async () => {
  const policy = await import("../src/upstream-image-retry-policy.js");
  assert.equal(typeof policy.imageRejectedFallbackChat, "function");

  const chat = policy.imageRejectedFallbackChat(
    { displayName: "Kimi K2.7 Code" },
    "HTTP 415 - unsupported image input",
  );

  assert.match(chat.id, /^chatcmpl_image_omitted_[a-z0-9]+_[a-z0-9]{6}$/);
  assert.deepEqual(
    {
      object: chat.object,
      choices: chat.choices,
      usage: chat.usage,
    },
    {
      object: "chat.completion",
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "这次消息里的图片没有继续发送给 Kimi K2.7 Code：上游模型拒绝了图片输入。" +
              "本轮历史已经改成文本占位，后续会话可以继续。" +
              " 去掉图片后上游仍返回：HTTP 415 - unsupported image input。" +
              "建议关闭这个模型的“图片上传”开关后重试，或切换到真正支持图片的模型。",
          },
        },
      ],
      usage: null,
    },
  );
});

test("image rejection fallback chat omits empty detail and falls back to the route id", async () => {
  const { imageRejectedFallbackChat } = await import(
    "../src/upstream-image-retry-policy.js"
  );

  const chat = imageRejectedFallbackChat({ id: "custom-vision-route" });

  assert.equal(
    chat.choices[0].message.content,
    "这次消息里的图片没有继续发送给 custom-vision-route：上游模型拒绝了图片输入。" +
      "本轮历史已经改成文本占位，后续会话可以继续。" +
      "建议关闭这个模型的“图片上传”开关后重试，或切换到真正支持图片的模型。",
  );
  assert.doesNotMatch(chat.choices[0].message.content, /仍返回/);
});

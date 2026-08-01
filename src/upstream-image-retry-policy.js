import { cloneJson } from "./json.js";

const IMAGE_REJECTED_PLACEHOLDER =
  "[image input omitted because upstream rejected image content]";

export function createUpstreamImageRetryPolicy({ UpstreamHttpError }) {
  function shouldRetryChatWithoutImages(error, body) {
    if (!(error instanceof UpstreamHttpError)) {
      return false;
    }
    if (!chatBodyHasImages(body)) {
      return false;
    }
    const statusCode = Number(error.statusCode);
    if (![400, 415, 422].includes(statusCode)) {
      return false;
    }
    const upstreamText = `${error.bodyText || ""} ${error.message || ""}`.toLowerCase();
    return (
      !upstreamText ||
      /image|vision|multi[-\s]?modal|image_url|input_image|unsupported media|content|part|invalid request/.test(
        upstreamText,
      )
    );
  }

  return { shouldRetryChatWithoutImages };
}

export function chatBodyWithoutImages(body) {
  const sanitized = cloneJson(body);
  sanitized.messages = chatMessagesWithoutImages(sanitized.messages);
  return sanitized;
}

export function chatMessagesWithoutImages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.map((message) => ({
    ...message,
    content: chatContentWithoutImages(message?.content),
  }));
}

export function imageRejectedFallbackChat(route = {}, retryDetail = "") {
  const displayName = route.displayName || route.id || "当前模型";
  const content =
    `这次消息里的图片没有继续发送给 ${displayName}：上游模型拒绝了图片输入。` +
    "本轮历史已经改成文本占位，后续会话可以继续。" +
    (retryDetail ? ` 去掉图片后上游仍返回：${retryDetail}。` : "") +
    "建议关闭这个模型的“图片上传”开关后重试，或切换到真正支持图片的模型。";
  return {
    id: `chatcmpl_image_omitted_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    object: "chat.completion",
    choices: [
      {
        message: {
          role: "assistant",
          content,
        },
      },
    ],
    usage: null,
  };
}

function chatBodyHasImages(body) {
  return Array.isArray(body?.messages) && body.messages.some(chatMessageHasImage);
}

function chatMessageHasImage(message) {
  return chatContentHasImage(message?.content);
}

function chatContentHasImage(content) {
  if (!content) {
    return false;
  }
  if (Array.isArray(content)) {
    return content.some(chatPartHasImage);
  }
  return chatPartHasImage(content);
}

function chatPartHasImage(part) {
  if (!part || typeof part !== "object") {
    return false;
  }
  const type = String(part.type || "").toLowerCase();
  return type === "image_url" || type.includes("image") || Boolean(part.image_url);
}

function chatContentWithoutImages(content) {
  if (!content) {
    return content;
  }
  if (!Array.isArray(content)) {
    return chatPartHasImage(content) ? IMAGE_REJECTED_PLACEHOLDER : content;
  }
  const sanitizedParts = [];
  for (const part of content) {
    if (chatPartHasImage(part)) {
      sanitizedParts.push({ type: "text", text: IMAGE_REJECTED_PLACEHOLDER });
      continue;
    }
    sanitizedParts.push(part);
  }
  return sanitizedParts;
}

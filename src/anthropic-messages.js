function safeJsonParse(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function contentBlocks(content) {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return content == null ? [] : [{ type: "text", text: String(content) }];
  }
  const blocks = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) blocks.push({ type: "text", text: part });
    } else if (["text", "input_text", "output_text"].includes(part?.type)) {
      if (part.text) blocks.push({ type: "text", text: String(part.text) });
    } else if (part?.type === "image_url" && part.image_url?.url) {
      const url = String(part.image_url.url);
      const dataUri = url.match(/^data:([^;,]+);base64,(.+)$/i);
      blocks.push({
        type: "image",
        source: dataUri
          ? { type: "base64", media_type: dataUri[1], data: dataUri[2] }
          : { type: "url", url },
      });
    } else if (
      part?.type === "thinking" &&
      typeof part.thinking === "string" &&
      typeof part.signature === "string"
    ) {
      blocks.push({
        type: "thinking",
        thinking: part.thinking,
        signature: part.signature,
      });
    } else if (
      part?.type === "redacted_thinking" &&
      typeof part.data === "string"
    ) {
      blocks.push({
        type: "redacted_thinking",
        data: part.data,
      });
    }
  }
  return blocks;
}

function preservedThinkingBlocks(message) {
  const source = Array.isArray(message?.anthropic_thinking)
    ? message.anthropic_thinking
    : [];
  return contentBlocks(source).filter((block) =>
    block.type === "thinking" || block.type === "redacted_thinking");
}

function appendMessage(messages, role, blocks) {
  if (!blocks.length) return;
  const previous = messages.at(-1);
  if (previous?.role === role && Array.isArray(previous.content)) {
    previous.content.push(...blocks);
  } else {
    messages.push({ role, content: blocks });
  }
}

function toolChoiceForAnthropic(value) {
  if (value === "auto") return { type: "auto" };
  if (value === "required") return { type: "any" };
  if (value === "none") return { type: "none" };
  const name = value?.function?.name;
  return name ? { type: "tool", name: String(name) } : undefined;
}

function chatCompletionStreamChunk(state, delta = {}, finishReason = null, usage = null) {
  const chunk = {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
    }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function chatFinishReason(stopReason) {
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  return "stop";
}

function parseSseEvent(rawEvent) {
  const data = [];
  let event = "";
  for (const line of String(rawEvent || "").split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  if (!data.length) return null;
  return {
    event,
    payload: safeJsonParse(data.join("\n"), null),
  };
}

export function createAnthropicChatCompletionStreamTranslator(route = {}) {
  const state = {
    id: `chatcmpl_anthropic_${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model: String(route.model || ""),
    inputTokens: 0,
    outputTokens: 0,
    buffer: "",
    roleSent: false,
    completed: false,
    finishSent: false,
    toolIndexes: new Map(),
    nextToolIndex: 0,
  };

  function translateEvent(event) {
    const payload = event?.payload;
    if (!payload || typeof payload !== "object") return [];
    if (event.event === "error" || payload.type === "error") {
      const message = payload.error?.message || "Anthropic streaming request failed.";
      const error = new Error(String(message));
      error.code = "anthropic_stream_error";
      throw error;
    }

    if (payload.type === "message_start") {
      const message = payload.message || {};
      state.id = String(message.id || state.id);
      state.model = String(message.model || state.model);
      state.inputTokens = Number(message.usage?.input_tokens || 0);
      state.outputTokens = Number(message.usage?.output_tokens || 0);
      if (!state.roleSent) {
        state.roleSent = true;
        return [chatCompletionStreamChunk(state, { role: "assistant" })];
      }
      return [];
    }

    if (payload.type === "content_block_start") {
      const block = payload.content_block || {};
      if (block.type === "tool_use") {
        const toolIndex = state.nextToolIndex++;
        state.toolIndexes.set(Number(payload.index || 0), toolIndex);
        return [chatCompletionStreamChunk(state, {
          tool_calls: [{
            index: toolIndex,
            id: String(block.id || `toolu_${toolIndex}`),
            type: "function",
            function: {
              name: String(block.name || ""),
              arguments: "",
            },
          }],
        })];
      }
      if (!state.roleSent) {
        state.roleSent = true;
        return [chatCompletionStreamChunk(state, { role: "assistant" })];
      }
      return [];
    }

    if (payload.type === "content_block_delta") {
      const delta = payload.delta || {};
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        return [chatCompletionStreamChunk(state, { content: delta.text })];
      }
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        return [chatCompletionStreamChunk(state, { reasoning_content: delta.thinking })];
      }
      if (delta.type === "signature_delta" && typeof delta.signature === "string") {
        return [chatCompletionStreamChunk(state, {
          anthropic_thinking_signature: delta.signature,
        })];
      }
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const blockIndex = Number(payload.index || 0);
        const toolIndex = state.toolIndexes.get(blockIndex) ?? blockIndex;
        return [chatCompletionStreamChunk(state, {
          tool_calls: [{
            index: toolIndex,
            function: {
              arguments: delta.partial_json,
            },
          }],
        })];
      }
      return [];
    }

    if (payload.type === "message_delta") {
      state.outputTokens = Number(payload.usage?.output_tokens || state.outputTokens || 0);
      if (state.finishSent) return [];
      state.finishSent = true;
      return [chatCompletionStreamChunk(
        state,
        {},
        chatFinishReason(payload.delta?.stop_reason),
        {
          prompt_tokens: state.inputTokens,
          completion_tokens: state.outputTokens,
          total_tokens: state.inputTokens + state.outputTokens,
        },
      )];
    }

    if (payload.type === "message_stop") {
      const output = [];
      if (!state.finishSent) {
        state.finishSent = true;
        output.push(chatCompletionStreamChunk(state, {}, "stop", {
          prompt_tokens: state.inputTokens,
          completion_tokens: state.outputTokens,
          total_tokens: state.inputTokens + state.outputTokens,
        }));
      }
      state.completed = true;
      output.push("data: [DONE]\n\n");
      return output;
    }
    return [];
  }

  return {
    push(chunk) {
      state.buffer = `${state.buffer}${String(chunk || "")}`
        .replace(/\r\n/g, "\n");
      const output = [];
      let separator = state.buffer.indexOf("\n\n");
      while (separator !== -1) {
        const rawEvent = state.buffer.slice(0, separator);
        state.buffer = state.buffer.slice(separator + 2);
        const event = parseSseEvent(rawEvent);
        if (event) output.push(...translateEvent(event));
        separator = state.buffer.indexOf("\n\n");
      }
      return output;
    },
    end() {
      const output = [];
      state.buffer = state.buffer.replace(/\r/g, "\n");
      const event = parseSseEvent(state.buffer);
      state.buffer = "";
      if (event) output.push(...translateEvent(event));
      return output;
    },
    get completed() {
      return state.completed;
    },
    get usage() {
      return {
        prompt_tokens: state.inputTokens,
        completion_tokens: state.outputTokens,
        total_tokens: state.inputTokens + state.outputTokens,
      };
    },
  };
}

export function chatRequestToAnthropicMessages(body = {}, route = {}) {
  const messages = [];
  const system = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const role = String(message?.role || "");
    if (role === "system" || role === "developer") {
      const text = contentBlocks(message.content)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (text) system.push(text);
      continue;
    }
    if (role === "tool") {
      appendMessage(messages, "user", [{
        type: "tool_result",
        tool_use_id: String(message.tool_call_id || ""),
        content: typeof message.content === "string"
          ? message.content
          : contentBlocks(message.content),
      }]);
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const blocks = contentBlocks(message.content);
    if (role === "assistant") {
      blocks.unshift(...preservedThinkingBlocks(message));
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (!call?.function?.name) continue;
        blocks.push({
          type: "tool_use",
          id: String(call.id || `toolu_${messages.length}_${blocks.length}`),
          name: String(call.function.name),
          input: safeJsonParse(call.function.arguments, {}),
        });
      }
    }
    appendMessage(messages, role, blocks);
  }

  const result = {
    model: String(body.model || route.model || ""),
    max_tokens: Math.max(
      1,
      Number(body.max_completion_tokens || body.max_tokens || route.maxOutputTokens || 8192),
    ),
    messages,
  };
  if (system.length) result.system = system.join("\n\n");
  if (Array.isArray(body.tools) && body.tools.length) {
    result.tools = body.tools
      .filter((tool) => tool?.type === "function" && tool.function?.name)
      .map((tool) => ({
        name: String(tool.function.name),
        ...(tool.function.description ? { description: String(tool.function.description) } : {}),
        input_schema: tool.function.parameters && typeof tool.function.parameters === "object"
          ? tool.function.parameters
          : { type: "object", properties: {} },
      }));
  }
  const toolChoice = toolChoiceForAnthropic(body.tool_choice);
  if (toolChoice?.type === "none") {
    delete result.tools;
  } else if (toolChoice) {
    result.tool_choice = toolChoice;
  }
  for (const key of ["temperature", "top_p", "top_k"]) {
    if (body[key] !== undefined) result[key] = body[key];
  }
  for (const key of ["stream", "thinking", "metadata", "service_tier"]) {
    if (body[key] !== undefined) {
      result[key] = body[key] && typeof body[key] === "object"
        ? structuredClone(body[key])
        : body[key];
    }
  }
  if (body.stop !== undefined) {
    result.stop_sequences = Array.isArray(body.stop) ? body.stop : [String(body.stop)];
  }
  return result;
}

export function anthropicMessageToChatCompletion(body = {}, route = {}) {
  const text = [];
  const toolCalls = [];
  const thinkingBlocks = [];
  for (const block of Array.isArray(body.content) ? body.content : []) {
    if (block?.type === "text" && block.text) {
      text.push(String(block.text));
    } else if (block?.type === "tool_use" && block.name) {
      toolCalls.push({
        id: String(block.id || `toolu_${toolCalls.length}`),
        type: "function",
        function: {
          name: String(block.name),
          arguments: JSON.stringify(block.input && typeof block.input === "object" ? block.input : {}),
        },
      });
    } else if (
      block?.type === "thinking" &&
      typeof block.thinking === "string" &&
      typeof block.signature === "string"
    ) {
      thinkingBlocks.push({
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature,
      });
    } else if (
      block?.type === "redacted_thinking" &&
      typeof block.data === "string"
    ) {
      thinkingBlocks.push({
        type: "redacted_thinking",
        data: block.data,
      });
    }
  }
  const inputTokens = Number(body.usage?.input_tokens || 0);
  const outputTokens = Number(body.usage?.output_tokens || 0);
  const message = { role: "assistant", content: text.join("") };
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (thinkingBlocks.length) {
    message.anthropic_thinking = thinkingBlocks;
    const reasoningText = thinkingBlocks
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking)
      .join("");
    if (reasoningText) message.reasoning_content = reasoningText;
  }
  return {
    id: String(body.id || `chatcmpl_anthropic_${Date.now()}`),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: String(body.model || route.model || ""),
    choices: [{
      index: 0,
      message,
      finish_reason: body.stop_reason === "tool_use"
        ? "tool_calls"
        : body.stop_reason === "max_tokens"
          ? "length"
          : "stop",
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

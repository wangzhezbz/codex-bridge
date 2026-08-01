import { tryParseJson } from "./json.js";
import { parseSseEvents } from "./sse.js";

export function hydrateStreamedImageGenerationResults(response, text = "") {
  if (!response || !Array.isArray(response.output)) {
    return response;
  }
  const byItemId = new Map();
  const byOutputIndex = new Map();
  for (const event of parseSseEvents(text)) {
    const data = tryParseJson(String(event?.data || "").trim());
    const outputItem = data?.type === "response.output_item.done" &&
      data?.item?.type === "image_generation_call"
      ? data.item
      : null;
    const result = outputItem
      ? (typeof outputItem.result === "string" ? outputItem.result.trim() : "")
      : data?.type === "response.image_generation_call.partial_image"
        ? (typeof data.partial_image_b64 === "string" ? data.partial_image_b64.trim() : "")
        : "";
    if (!result) {
      continue;
    }
    const candidate = {
      result,
      revisedPrompt: typeof outputItem?.revised_prompt === "string"
        ? outputItem.revised_prompt
        : "",
      itemId: outputItem?.id || data.item_id || "",
      outputIndex: Number.isInteger(data.output_index) ? data.output_index : -1,
      outputItem,
    };
    const itemId = outputItem?.id || data.item_id;
    if (typeof itemId === "string" && itemId) {
      byItemId.set(itemId, candidate);
    }
    if (Number.isInteger(data.output_index) && data.output_index >= 0) {
      byOutputIndex.set(data.output_index, candidate);
    }
  }
  const appliedCandidates = new Set();
  response.output.forEach((item, outputIndex) => {
    if (
      item?.type !== "image_generation_call" ||
      (typeof item.result === "string" && item.result.trim())
    ) {
      return;
    }
    const candidate = byItemId.get(item.id) || byOutputIndex.get(outputIndex);
    if (candidate?.result) {
      appliedCandidates.add(candidate);
      item.result = candidate.result;
      if (!item.revised_prompt && candidate.revisedPrompt) {
        item.revised_prompt = candidate.revisedPrompt;
      }
    }
  });
  const streamedCandidates = [...new Set([
    ...byOutputIndex.values(),
    ...byItemId.values(),
  ])]
    .filter((candidate) => candidate?.result && !appliedCandidates.has(candidate))
    .sort((left, right) => left.outputIndex - right.outputIndex);
  for (const candidate of streamedCandidates) {
    response.output.push({
      ...(candidate.outputItem || {}),
      id: candidate.itemId || candidate.outputItem?.id || `image_generation_${response.output.length}`,
      type: "image_generation_call",
      status: candidate.outputItem?.status || "completed",
      result: candidate.result,
      ...(candidate.revisedPrompt ? { revised_prompt: candidate.revisedPrompt } : {}),
    });
  }
  return response;
}

import { stringifyJson } from "./json.js";

export function bridgeCapabilityToolContent(result = {}) {
  const response = result?.response && typeof result.response === "object"
    ? result.response
    : result;
  const data = response?.data || result?.upstream || {};
  const text = response?.output_text || response?.text || data?.text || "";
  const structuredData = bridgeCapabilityResultData(data);
  if (response?.localPath || result?.localPath) {
    structuredData.localPath = response.localPath || result.localPath || "";
  }
  if (response?.mimeType || result?.mimeType) {
    structuredData.mimeType = response.mimeType || result.mimeType || "";
  }
  if (response?.sourceUrl || result?.sourceUrl) {
    structuredData.sourceUrl = response.sourceUrl || result.sourceUrl || "";
  }
  return stringifyJson({
    ok: Boolean(result?.handled && !result?.skipped && !result?.failed),
    capability: response?.capability || result?.capability || "capability",
    providerId: response?.providerId || result?.providerId || "",
    providerName: response?.providerName || result?.providerName || "",
    output_text: text,
    data: structuredData,
  });
}

function bridgeCapabilityResultData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {};
  }
  return {
    action: data.action || "",
    url: data.url || "",
    query: data.query || "",
    fileUrl: data.fileUrl || data.file_url || "",
    fileName: data.fileName || data.file_name || data.filename || "",
    imageUrl: data.imageUrl || data.image_url || data.screenshotUrl || data.screenshot_url || "",
    audioUrl: data.audioUrl || data.audio_url || data.speechUrl || data.speech_url || "",
    videoUrl: data.videoUrl || data.video_url || "",
    localPath: data.localPath || data.local_path || "",
    mimeType: data.mimeType || data.mime_type || "",
    sourceUrl: data.sourceUrl || data.source_url || "",
    text: data.text || "",
    prompt: data.prompt || "",
    title: data.title || "",
    status: data.status || "",
    contentType: data.contentType || "",
    answer: data.answer || data.output_text || data.summary || "",
    sources: Array.isArray(data.sources) ? data.sources.slice(0, 5) : [],
    excerpt: data.excerpt || data.text || "",
    truncated: Boolean(data.truncated),
  };
}

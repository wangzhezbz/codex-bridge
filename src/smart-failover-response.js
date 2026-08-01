import { safeText } from "./upstream-network-errors.js";

export function smartFailoverNotice(metadata = {}, labels = {}) {
  const fromLabel = labels.fromDisplayName || metadata.fromModel || metadata.fromRoute || "原模型";
  const toLabel = labels.toDisplayName || metadata.toModel || metadata.toRoute || "备用模型";
  const reason = smartFailoverReasonLabel(metadata.reason);
  return `已自动切换模型：${fromLabel} -> ${toLabel}。原因：${reason}。`;
}

export function annotateSmartFailoverResponse(response = {}, route = {}, context = {}) {
  const fromRoute = safeText(context.failoverFromRoute || "", 120);
  const reason = safeText(context.smartFailoverReason || "", 120);
  if (!fromRoute || !reason || !response || typeof response !== "object") {
    return response;
  }
  const metadata = {
    fromRoute,
    fromModel: safeText(context.failoverFromModel || "", 160),
    toRoute: safeText(route.id || "", 120),
    toModel: safeText(route.model || "", 160),
    reason,
  };
  response.codexbridge_smart_failover = metadata;
  const note = smartFailoverNotice(metadata, {
    fromDisplayName: context.failoverFromDisplayName,
    toDisplayName: route.displayName || route.id || route.model,
  });
  if (note) {
    prependResponseOutputText(response, note);
  }
  return response;
}

function smartFailoverReasonLabel(reason = "") {
  const labels = {
    rate_limited: "原供应商限流",
    quota_or_balance: "原供应商余额或额度不足",
    upstream_unavailable: "原供应商暂时不可用",
  };
  return labels[reason] || reason || "原供应商请求失败";
}

export function prependResponseOutputText(response = {}, note = "") {
  const cleanNote = String(note || "").trim();
  if (!cleanNote) {
    return;
  }
  const oldText = String(response.output_text || "").trim();
  response.output_text = oldText ? `${cleanNote}\n\n${oldText}` : cleanNote;
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!item || item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    const textPart = item.content.find(
      (part) => part?.type === "output_text" && typeof part.text === "string",
    );
    if (textPart) {
      const text = textPart.text.trim();
      textPart.text = text ? `${cleanNote}\n\n${text}` : cleanNote;
      return;
    }
  }
  if (!output.length) {
    response.output = [
      {
        id: `msg_${response.id || Date.now().toString(36)}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: response.output_text,
            annotations: [],
          },
        ],
      },
    ];
  }
}

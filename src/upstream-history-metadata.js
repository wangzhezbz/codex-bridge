import { normalizeAdapterProfile } from "./adapter-profile.js";
import { contextPolicyForRoute } from "./context-policy.js";
import { createRouteSnapshot } from "./route-snapshot.js";

export function buildHistoryTurn(
  response,
  messages,
  meta = {},
  { requestBody = {}, route = {} } = {},
) {
  if (!response?.id) {
    return null;
  }
  return {
    responseId: response.id,
    messages,
    response,
    meta: {
      ...meta,
      parentResponseId: requestBody.previous_response_id || null,
      routeSnapshot: routeSnapshotForHistory(route),
    },
  };
}

export function routeSnapshotForHistory(route = {}) {
  try {
    return createRouteSnapshot(route, {
      contextPolicy: contextPolicyForRoute(route, {
        defaultContextWindow: normalizeAdapterProfile(route).contextWindow,
      }),
    });
  } catch {
    // Keep the response durable even when a malformed legacy route cannot
    // produce a trusted snapshot. A later cross-route switch will fail closed.
    return {
      id: route.id || "",
      api: route.api || "",
      model: route.model || "",
    };
  }
}

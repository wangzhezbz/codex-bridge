import test from "node:test";
import assert from "node:assert/strict";

import { routeDecisionTraceDetails } from "../src/route-decision-trace.js";

test("routeDecisionTraceDetails formats smart failover facts without changing the selected route", () => {
  assert.deepEqual(
    routeDecisionTraceDetails(
      {
        requestedModel: " requested\nmodel ",
        failoverFromRoute: "cb-main\r\nroute",
        failoverFromDisplayName: "Main\nRoute",
        failoverFromModel: "main\rmodel",
        smartFailoverReason: " rate\n limited ",
      },
      {
        id: "cb-backup",
        displayName: "Backup\nRoute",
        model: "backup-model",
        api: "responses",
      },
    ),
    {
      reason: "smart_failover",
      failoverReason: "rate limited",
      requestedModel: "requested model",
      originalRoute: "cb-main route",
      originalDisplayName: "Main Route",
      originalUpstreamModel: "main model",
      selectedRoute: "cb-backup",
      selectedDisplayName: "Backup Route",
      selectedUpstreamModel: "backup-model",
      selectedApi: "responses",
      changed: true,
    },
  );
});

test("routeDecisionTraceDetails formats a versioned route-plan decision and filters invalid skipped routes", () => {
  assert.deepEqual(
    routeDecisionTraceDetails(
      {
        requestedModel: "context-model",
        routePlan: {
          decision: {
            version: "route-decision-v2",
            requestKind: "responses\nstream",
            reason: "capability\nmatch",
            requestedModel: "planned-model",
            originalRoute: {
              id: "cb-original",
              displayName: "Original Route",
              upstreamModel: "original-model",
            },
            selectedRoute: {
              id: "cb-selected",
              displayName: "Selected Route",
              upstreamModel: "selected-model",
              api: "responses",
            },
            changed: true,
            rewriteModel: "rewritten\nmodel",
            skippedRoutes: [
              { routeId: "cb-excluded", reason: "unhealthy\nroute", detail: "cooldown\ractive" },
              { id: "cb-fallback", detail: "missing capability" },
              { reason: "missing id" },
              null,
            ],
            userMessage: "Route\nchanged",
          },
        },
      },
      { id: "runtime-route", model: "runtime-model", api: "chat_completions" },
    ),
    {
      decisionVersion: "route-decision-v2",
      requestKind: "responses stream",
      reason: "capability match",
      requestedModel: "planned-model",
      originalRoute: "cb-original",
      originalDisplayName: "Original Route",
      originalUpstreamModel: "original-model",
      selectedRoute: "cb-selected",
      selectedDisplayName: "Selected Route",
      selectedUpstreamModel: "selected-model",
      selectedApi: "responses",
      changed: true,
      rewriteModel: "rewritten model",
      skippedRoutes: [
        { routeId: "cb-excluded", reason: "unhealthy route", detail: "cooldown active" },
        { routeId: "cb-fallback", reason: "excluded", detail: "missing capability" },
      ],
      userMessage: "Route changed",
    },
  );
});

test("routeDecisionTraceDetails preserves the legacy route-selection trace shape", () => {
  assert.deepEqual(
    routeDecisionTraceDetails(
      {
        requestedModel: "requested-model",
        routeSelection: {
          reason: "compatibility",
          changed: true,
          originalRoute: {
            id: "cb-original",
            displayName: "Original",
            model: "original-model",
          },
          route: {
            id: "cb-selected",
            displayName: "Selected",
            model: "selected-model",
            api: "anthropic_messages",
          },
        },
      },
      { id: "runtime-route", model: "runtime-model", api: "responses" },
    ),
    {
      reason: "compatibility",
      requestedModel: "requested-model",
      originalRoute: "cb-original",
      originalDisplayName: "Original",
      originalUpstreamModel: "original-model",
      selectedRoute: "cb-selected",
      selectedDisplayName: "Selected",
      selectedUpstreamModel: "selected-model",
      selectedApi: "anthropic_messages",
      changed: true,
    },
  );
});

test("routeDecisionTraceDetails reports an unchanged manual route when no decision exists", () => {
  assert.deepEqual(
    routeDecisionTraceDetails(
      { requestedModel: "" },
      {
        id: "cb-manual",
        displayName: "Manual Route",
        model: "manual-model",
        api: "chat_completions",
      },
    ),
    {
      reason: "manual_route",
      requestedModel: "cb-manual",
      originalRoute: "cb-manual",
      originalDisplayName: "Manual Route",
      originalUpstreamModel: "manual-model",
      selectedRoute: "cb-manual",
      selectedDisplayName: "Manual Route",
      selectedUpstreamModel: "manual-model",
      selectedApi: "chat_completions",
      changed: false,
    },
  );
});

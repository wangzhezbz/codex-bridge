import test from "node:test";
import assert from "node:assert/strict";

import {
  ROUTE_DECISION_VERSION,
  createRoutePlan,
  routePlanProblemMessage,
} from "../src/route-plan.js";

function route(overrides = {}) {
  return {
    id: "cb-main",
    displayName: "Main",
    api: "chat_completions",
    baseUrl: "https://api.example.com/v1",
    model: "main-model",
    apiKey: "test-key",
    provider: "example",
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    defaultModel: "cb-main",
    models: [
      route(),
      route({
        id: "cb-helper",
        displayName: "Helper",
        model: "helper-model",
      }),
    ],
    ...overrides,
  };
}

test("createRoutePlan routes Codex auxiliary tasks through the configured helper model", () => {
  const plan = createRoutePlan(
    config({
      codexAuxiliaryTasks: {
        intercept: false,
        routeId: "cb-helper",
      },
    }),
    {
      model: "gpt-5.4-mini",
      input: "compact this",
    },
    {
      isCodexClient: true,
      routeOptions: {
        exactModelIdOnly: true,
      },
    },
  );

  assert.equal(plan.requestKind, "codex_auxiliary");
  assert.equal(plan.route.id, "cb-helper");
  assert.equal(plan.reason, "codex_auxiliary_task");
  assert.equal(plan.rewriteModel, "helper-model");
  assert.equal(plan.decision.version, ROUTE_DECISION_VERSION);
  assert.equal(plan.decision.requestKind, "codex_auxiliary");
  assert.equal(plan.decision.selectedRoute.id, "cb-helper");
  assert.equal(plan.decision.selectedRoute.upstreamModel, "helper-model");
  assert.equal(plan.decision.rewriteModel, "helper-model");
});

test("createRoutePlan records route decision v2 with skipped route reasons", () => {
  const plan = createRoutePlan(
    config({
      smartRouting: {
        autoSelectModel: true,
      },
      models: [
        route({
          id: "cb-chat",
          displayName: "Chat",
          model: "chat-model",
        }),
        route({
          id: "cb-code",
          displayName: "Code Pro",
          model: "code-model",
        }),
      ],
    }),
    {
      model: "cb-chat",
      input: "write a TypeScript function",
    },
    {
      routeExclusions: {
        items: [
          {
            routeId: "cb-code",
            reason: "budget",
            detail: "daily budget reached",
          },
        ],
      },
    },
  );

  assert.equal(plan.route.id, "cb-chat");
  assert.equal(plan.reason, "manual_route");
  assert.equal(plan.decision.version, ROUTE_DECISION_VERSION);
  assert.equal(plan.decision.requestKind, "normal");
  assert.equal(plan.decision.requestedModel, "cb-chat");
  assert.equal(plan.decision.originalRoute.id, "cb-chat");
  assert.equal(plan.decision.selectedRoute.id, "cb-chat");
  assert.equal(plan.decision.changed, false);
  assert.deepEqual(plan.decision.skippedRoutes, [
    {
      routeId: "cb-code",
      reason: "budget",
      detail: "daily budget reached",
    },
  ]);
  assert.match(plan.decision.userMessage, /Chat/);
});

test("createRoutePlan does not silently fallback when configured auxiliary model was deleted", () => {
  assert.throws(
    () =>
      createRoutePlan(
        config({
          codexAuxiliaryTasks: {
            intercept: false,
            routeId: "cb-deleted",
          },
        }),
        {
          model: "gpt-5.4-mini",
          input: "compact this",
        },
        {
          isCodexClient: true,
          routeOptions: {
            exactModelIdOnly: true,
          },
        },
      ),
    (error) => {
      assert.equal(error.code, "auxiliary_route_not_available");
      assert.equal(error.details.configuredRouteId, "cb-deleted");
      assert.deepEqual(error.details.availableRouteIds, ["cb-main", "cb-helper"]);
      assert.match(routePlanProblemMessage(error), /辅助任务模型不可用/);
      return true;
    },
  );
});

test("createRoutePlan does not use a disabled configured auxiliary route", () => {
  assert.throws(
    () =>
      createRoutePlan(
        config({
          models: [
            route(),
            route({
              id: "cb-helper",
              displayName: "Helper",
              model: "helper-model",
              enabled: false,
            }),
          ],
          codexAuxiliaryTasks: {
            intercept: false,
            routeId: "cb-helper",
          },
        }),
        {
          model: "gpt-5.4-mini",
          input: "compact this",
        },
        {
          isCodexClient: true,
          routeOptions: {
            exactModelIdOnly: true,
          },
        },
      ),
    (error) => {
      assert.equal(error.code, "auxiliary_route_not_available");
      assert.equal(error.details.configuredRouteId, "cb-helper");
      assert.deepEqual(error.details.availableRouteIds, ["cb-main"]);
      return true;
    },
  );
});

test("createRoutePlan does not use an unauthenticated configured auxiliary route", () => {
  assert.throws(
    () =>
      createRoutePlan(
        config({
          models: [
            route(),
            route({
              id: "cb-helper",
              displayName: "Helper",
              model: "helper-model",
              apiKey: "",
              apiKeyEnv: "",
            }),
          ],
          codexAuxiliaryTasks: {
            intercept: false,
            routeId: "cb-helper",
          },
        }),
        {
          model: "gpt-5.4-mini",
          input: "compact this",
        },
        {
          isCodexClient: true,
          routeOptions: {
            exactModelIdOnly: true,
          },
        },
      ),
    (error) => {
      assert.equal(error.code, "auxiliary_route_not_available");
      assert.equal(error.details.configuredRouteId, "cb-helper");
      assert.deepEqual(error.details.availableRouteIds, ["cb-main"]);
      return true;
    },
  );
});

test("createRoutePlan uses first route for auxiliary tasks only when no helper route is selected", () => {
  const plan = createRoutePlan(
    config({
      codexAuxiliaryTasks: {
        intercept: false,
        routeId: "",
      },
    }),
    {
      model: "gpt-5.4",
      input: "compact this",
    },
    {
      isCodexClient: true,
      routeOptions: {
        exactModelIdOnly: true,
      },
    },
  );

  assert.equal(plan.route.id, "cb-main");
  assert.equal(plan.reason, "codex_auxiliary_task");
  assert.equal(plan.rewriteModel, "main-model");
});

test("createRoutePlan uses the first usable route when no auxiliary helper route is selected", () => {
  const plan = createRoutePlan(
    config({
      models: [
        route({
          enabled: false,
        }),
        route({
          id: "cb-helper",
          displayName: "Helper",
          model: "helper-model",
        }),
      ],
      codexAuxiliaryTasks: {
        intercept: false,
        routeId: "",
      },
    }),
    {
      model: "gpt-5.4",
      input: "compact this",
    },
    {
      isCodexClient: true,
      routeOptions: {
        exactModelIdOnly: true,
      },
    },
  );

  assert.equal(plan.route.id, "cb-helper");
  assert.equal(plan.reason, "codex_auxiliary_task");
  assert.equal(plan.rewriteModel, "helper-model");
});

test("createRoutePlan skips currently excluded routes for auxiliary fallback", () => {
  const plan = createRoutePlan(
    config({
      codexAuxiliaryTasks: {
        intercept: false,
        routeId: "",
      },
    }),
    {
      model: "gpt-5.4",
      input: "compact this",
    },
    {
      isCodexClient: true,
      routeOptions: {
        exactModelIdOnly: true,
      },
      routeExclusions: {
        ids: ["cb-main"],
      },
    },
  );

  assert.equal(plan.route.id, "cb-helper");
  assert.equal(plan.reason, "codex_auxiliary_task");
});

test("createRoutePlan routes stale cb-* Codex model ids to the current default route", () => {
  const plan = createRoutePlan(
    config({
      defaultModel: "cb-helper",
    }),
    {
      model: "cb-old-model",
      input: "hello",
    },
    {
      isCodexClient: true,
      routeOptions: {
        exactModelIdOnly: true,
      },
    },
  );

  assert.equal(plan.requestKind, "stale_codex_model");
  assert.equal(plan.route.id, "cb-helper");
  assert.equal(plan.reason, "stale_model_fallback");
  assert.equal(plan.rewriteModel, "");
});

test("createRoutePlan routes stale cb-* ids to the first usable route when the saved default is unavailable", () => {
  const plan = createRoutePlan(
    config({
      defaultModel: "cb-main",
      models: [
        route({
          enabled: false,
        }),
        route({
          id: "cb-helper",
          displayName: "Helper",
          model: "helper-model",
        }),
      ],
    }),
    {
      model: "cb-old-model",
      input: "hello",
    },
    {
      isCodexClient: true,
      routeOptions: {
        exactModelIdOnly: true,
      },
    },
  );

  assert.equal(plan.requestKind, "stale_codex_model");
  assert.equal(plan.route.id, "cb-helper");
  assert.equal(plan.reason, "stale_model_fallback");
});

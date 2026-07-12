import test from "node:test";
import assert from "node:assert/strict";

import { runModeSelect } from "../desktop/mode-switch-handler.mjs";

const CANDIDATE_CONFIG = {
  mode: "all_api",
  models: [{ id: "model-a" }, { id: "model-b" }],
};

const OLD_CONFIG = {
  mode: "hybrid",
  models: [{ id: "old-model" }],
};

function baseSettings(overrides = {}) {
  return {
    MODE_HYBRID: "hybrid",
    MODE_ALL_API: "all_api",
    defaultSelectedModelIds: () => ["model-a", "model-b"],
    readRouterConfig: () => OLD_CONFIG,
    applyModeSwitchTransaction: async ({ verifyCommitted }) => {
      await verifyCommitted?.({ value: { routerConfig: CANDIDATE_CONFIG } });
      return {
        revision: "committed-r1",
        configRevision: "committed-r1",
        restartRequired: true,
        codexRestartRequired: true,
      };
    },
    ...overrides,
  };
}

function successDependencies(overrides = {}) {
  return {
    rootDir: "C:\\fixture\\router",
    homeDir: "C:\\fixture\\home",
    mode: "all_api",
    routerRunning: true,
    refreshRouterHealth: async () => ({
      ok: true,
      models: ["model-b", "model-a"],
    }),
    locateCodexInstall: async () => ({
      found: true,
      launchTarget: "C:\\Apps\\Codex.exe",
      kind: "executable",
      source: "saved",
    }),
    broadcastState: async () => undefined,
    getStatePayload: async () => ({ mode: "all_api", selectedModelIds: ["model-a", "model-b"] }),
    appendLog: () => undefined,
    ...overrides,
  };
}

test("mode selection waits for the transaction and running Router verification before locator and broadcast", async () => {
  const events = [];
  let releaseTransaction;
  const transactionGate = new Promise((resolve) => {
    releaseTransaction = resolve;
  });
  let locatorCalls = 0;
  let broadcastCalls = 0;

  const settings = baseSettings({
    applyModeSwitchTransaction: async ({ verifyCommitted }) => {
      events.push("transaction:start");
      await transactionGate;
      await verifyCommitted({ value: { routerConfig: CANDIDATE_CONFIG } });
      events.push("transaction:resolved");
      return {
        revision: "committed-order",
        configRevision: "committed-order",
        restartRequired: true,
      };
    },
  });

  const pending = runModeSelect({
    settings,
    ...successDependencies({
      refreshRouterHealth: async (config) => {
        assert.equal(config, CANDIDATE_CONFIG);
        events.push("health");
        return { ok: true, models: ["model-b", "model-a"] };
      },
      locateCodexInstall: async () => {
        locatorCalls += 1;
        events.push("locator");
        return { found: false, launchTarget: "", kind: null, source: null };
      },
      getStatePayload: async () => {
        events.push("state");
        return { mode: "all_api", selectedModelIds: ["model-a", "model-b"] };
      },
      broadcastState: async () => {
        broadcastCalls += 1;
        events.push("broadcast");
      },
    }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(locatorCalls, 0);
  assert.equal(broadcastCalls, 0);

  releaseTransaction();
  await pending;

  assert.deepEqual(events, [
    "transaction:start",
    "health",
    "transaction:resolved",
    "locator",
    "state",
    "broadcast",
  ]);
});

for (const scenario of [
  {
    name: "model mismatch",
    candidateHealth: { ok: true, models: ["model-a"] },
  },
  {
    name: "health failure",
    candidateHealth: { ok: false, models: [], message: "not ready" },
  },
]) {
  test(`running Router ${scenario.name} rejects, refreshes restored config best-effort, and does not publish`, async () => {
    const healthConfigs = [];
    let locatorCalls = 0;
    let broadcastCalls = 0;
    const transactionError = Object.assign(new Error("Configuration transaction failed"), {
      code: "config_transaction_failed",
    });
    const settings = baseSettings({
      applyModeSwitchTransaction: async ({ verifyCommitted }) => {
        try {
          await verifyCommitted({ value: { routerConfig: CANDIDATE_CONFIG } });
        } catch {
          throw transactionError;
        }
        assert.fail("verification should reject the transaction");
      },
    });

    await assert.rejects(
      () => runModeSelect({
        settings,
        ...successDependencies({
          refreshRouterHealth: async (config) => {
            healthConfigs.push(config);
            return config === CANDIDATE_CONFIG
              ? scenario.candidateHealth
              : { ok: true, models: ["old-model"] };
          },
          locateCodexInstall: async () => {
            locatorCalls += 1;
            return { found: false, launchTarget: "", kind: null, source: null };
          },
          broadcastState: async () => {
            broadcastCalls += 1;
          },
        }),
      }),
      (error) => error === transactionError,
    );

    assert.deepEqual(healthConfigs, [CANDIDATE_CONFIG, OLD_CONFIG]);
    assert.equal(locatorCalls, 0);
    assert.equal(broadcastCalls, 0);
  });
}

test("stopped Router skips health verification", async () => {
  let healthCalls = 0;
  let receivedVerifyCommitted = "not-called";
  const logs = [];
  const settings = baseSettings({
    applyModeSwitchTransaction: async (options) => {
      receivedVerifyCommitted = options.verifyCommitted;
      return {
        revision: "committed-stopped",
        configRevision: "committed-stopped",
        restartRequired: true,
      };
    },
  });

  const result = await runModeSelect({
    settings,
    ...successDependencies({
      routerRunning: false,
      refreshRouterHealth: async () => {
        healthCalls += 1;
        return { ok: true, models: [] };
      },
      appendLog: (message) => logs.push(message),
    }),
  });

  assert.equal(receivedVerifyCommitted, undefined);
  assert.equal(healthCalls, 0);
  assert.equal(result.transaction.routerVerified, false);
  assert.doesNotMatch(logs.join("\n"), /verified Router/i);
  assert.match(logs.join("\n"), /atomically/i);
});

test("success returns state with committed transaction and restart availability without logging a draft", async () => {
  const logs = [];
  const state = { mode: "all_api", selectedModelIds: ["model-a", "model-b"] };
  const settings = baseSettings({
    applyModeSwitchTransaction: async ({ verifyCommitted }) => {
      await verifyCommitted({ value: { routerConfig: CANDIDATE_CONFIG } });
      return {
        revision: "draft-looking-but-committed",
        configRevision: "draft-looking-but-committed",
        restartRequired: true,
        codexRestartRequired: true,
      };
    },
  });

  const result = await runModeSelect({
    settings,
    ...successDependencies({
      getStatePayload: async () => state,
      appendLog: (message) => logs.push(message),
    }),
  });

  assert.equal(result.state, state);
  assert.deepEqual(result.transaction, {
    revision: "draft-looking-but-committed",
    configRevision: "draft-looking-but-committed",
    restartRequired: true,
    restartAvailable: true,
    routerVerified: true,
    launchTarget: "C:\\Apps\\Codex.exe",
    kind: "executable",
    source: "saved",
  });
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /draft/i);
});

test("post-commit state, log, and broadcast failures cannot make a durable mode switch retryable", async () => {
  const result = await runModeSelect({
    settings: baseSettings(),
    ...successDependencies({
      getStatePayload: async () => {
        throw new Error("injected state failure");
      },
      appendLog: () => {
        throw new Error("injected log failure");
      },
      broadcastState: async () => {
        throw new Error("injected broadcast failure");
      },
    }),
  });

  assert.deepEqual(result.state, { stateUnavailable: true });
  assert.equal(result.transaction.configRevision, "committed-r1");
});

test("transaction failure performs no locator lookup, state read, or broadcast", async () => {
  const transactionError = Object.assign(new Error("Configuration transaction failed"), {
    code: "config_transaction_failed",
  });
  let locatorCalls = 0;
  let stateCalls = 0;
  let broadcastCalls = 0;
  const settings = baseSettings({
    applyModeSwitchTransaction: async () => {
      throw transactionError;
    },
  });

  await assert.rejects(
    () => runModeSelect({
      settings,
      ...successDependencies({
        routerRunning: false,
        locateCodexInstall: async () => {
          locatorCalls += 1;
          return { found: false, launchTarget: "", kind: null, source: null };
        },
        getStatePayload: async () => {
          stateCalls += 1;
          return {};
        },
        broadcastState: async () => {
          broadcastCalls += 1;
        },
      }),
    }),
    (error) => error === transactionError,
  );

  assert.equal(locatorCalls, 0);
  assert.equal(stateCalls, 0);
  assert.equal(broadcastCalls, 0);
});

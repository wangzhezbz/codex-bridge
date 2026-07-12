import { createRoutePlan } from "./route-plan.js";
import { selectFailoverRoute } from "./smart-routing.js";

export function evaluateRouteContractMatrix(config = {}, cases = [], options = {}) {
  const rows = (Array.isArray(cases) ? cases : []).map((contract) =>
    evaluateRouteContractCase(config, contract, options),
  );
  const passed = rows.filter((row) => row.ok).length;
  const failed = rows.length - passed;
  return {
    ok: failed === 0,
    summary: {
      total: rows.length,
      passed,
      failed,
    },
    rows,
  };
}

export function evaluateRouteContractCase(baseConfig = {}, contract = {}, options = {}) {
  const id = String(contract.id || "").trim() || "unnamed-contract";
  const kind = String(contract.kind || "route").trim();
  const config = contract.config || baseConfig;
  try {
    const actual = kind === "failover"
      ? evaluateFailoverContract(config, contract, options)
      : evaluateRoutePlanContract(config, contract, options);
    const mismatches = contract.expectErrorCode
      ? [`expected error ${contract.expectErrorCode}, got success`]
      : contractMismatches(actual, contract.expect);
    return {
      id,
      kind,
      ok: mismatches.length === 0,
      expected: contract.expect || {},
      actual,
      mismatches,
    };
  } catch (error) {
    const actual = {
      errorCode: String(error?.code || ""),
      message: String(error?.message || ""),
    };
    const expectedErrorCode = String(contract.expectErrorCode || "").trim();
    const mismatches = expectedErrorCode && actual.errorCode === expectedErrorCode
      ? []
      : [`expected ${expectedErrorCode || "success"}, got error ${actual.errorCode || "unknown"}`];
    return {
      id,
      kind,
      ok: mismatches.length === 0,
      expected: expectedErrorCode ? { errorCode: expectedErrorCode } : contract.expect || {},
      actual,
      mismatches,
    };
  }
}

function evaluateRoutePlanContract(config = {}, contract = {}, options = {}) {
  const plan = createRoutePlan(
    config,
    contract.request || {},
    {
      ...options.routePlanOptions,
      ...(contract.options || {}),
    },
  );
  return {
    routeId: plan.route?.id || "",
    requestKind: plan.requestKind || "",
    reason: plan.reason || "",
    decisionVersion: plan.decision?.version || "",
    rewriteModel: plan.rewriteModel || "",
    changed: Boolean(plan.changed),
  };
}

function evaluateFailoverContract(config = {}, contract = {}, options = {}) {
  const currentRoute = routeById(config.models, contract.currentRouteId);
  const result = selectFailoverRoute(
    config,
    currentRoute,
    contract.error || {},
    {
      ...options.failoverOptions,
      ...(contract.options || {}),
    },
  );
  return {
    routeId: result?.route?.id || "",
    reason: result?.reason || "",
    changed: Boolean(result?.changed),
  };
}

function contractMismatches(actual = {}, expected = {}) {
  const wanted = expected && typeof expected === "object" && !Array.isArray(expected)
    ? expected
    : {};
  return Object.entries(wanted).flatMap(([key, value]) =>
    actual[key] === value ? [] : [`${key}: expected ${String(value)}, got ${String(actual[key] ?? "")}`],
  );
}

function routeById(routes = [], routeId = "") {
  const wanted = String(routeId || "").trim();
  return (Array.isArray(routes) ? routes : []).find((route) => route?.id === wanted) || null;
}

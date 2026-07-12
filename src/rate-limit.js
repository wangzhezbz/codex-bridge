const DEFAULT_429_COOLDOWN_MS = 30_000;
const MAX_429_COOLDOWN_MS = 120_000;

const providerCooldowns = new Map();
const localPacingStates = new Map();

let clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class RouteRateLimitedError extends Error {
  constructor(route = {}, retryAfterMs = 0) {
    super(
      `供应商暂时限流：${route.displayName || route.id || route.model || "当前路由"}。` +
        `请在 ${Math.ceil(Math.max(0, retryAfterMs) / 1000)}s 后重试。`,
    );
    this.name = "RouteRateLimitedError";
    this.statusCode = 429;
    this.code = "provider_rate_limited";
    this.retryAfterMs = Math.max(0, retryAfterMs);
    this.route = {
      id: route.id || "",
      displayName: route.displayName || "",
      model: route.model || "",
      api: route.api || "",
    };
  }
}

export async function waitForRouteCapacity(route = {}, context = {}, options = {}) {
  await waitForProviderCooldown(route, context, options);
  if (!localRateLimitEnabled(route, options)) {
    return;
  }
  const state = localPacingStateForRoute(route);
  state.queue = state.queue
    .catch(() => {})
    .then(() => reserveLocalPacing(state, route, context, options));
  return state.queue;
}

export function markRouteRateLimited(route = {}, headers) {
  const headerCooldownMs = retryAfterMs(headers);
  const fallbackCooldownMs = Math.max(
    Number(route.cooldownMs || 0),
    DEFAULT_429_COOLDOWN_MS,
  );
  const cooldownMs = clampCooldownMs(
    headerCooldownMs || fallbackCooldownMs,
    route,
  );
  const cooldownUntil = clock.now() + Math.max(0, cooldownMs);
  const key = providerIdentityKey(route);
  providerCooldowns.set(
    key,
    Math.max(Number(providerCooldowns.get(key) || 0), cooldownUntil),
  );
}

export function routeRateLimitStatus(route = {}) {
  const now = clock.now();
  const key = providerIdentityKey(route);
  const providerCooldownRemainingMs = Math.max(
    0,
    Number(providerCooldowns.get(key) || 0) - now,
  );
  const localPacingState = localPacingStates.get(key);
  const localPacingNextAfterMs = localRateLimitEnabled(route)
    ? Math.max(0, Number(localPacingState?.nextAt || 0) - now)
    : 0;
  return {
    providerCooldownRemainingMs,
    localPacingNextAfterMs,
    cooldownRemainingMs: providerCooldownRemainingMs,
    nextAfterMs: localPacingNextAfterMs,
  };
}

export function __setRateLimitClockForTests(nextClock) {
  clock = {
    now: nextClock?.now || clock.now,
    sleep: nextClock?.sleep || clock.sleep,
  };
}

export function __resetRateLimiterForTests() {
  providerCooldowns.clear();
  localPacingStates.clear();
  clock = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

async function reserveLocalPacing(state, route, context, options = {}) {
  await waitUntil(state.nextAt || 0);

  const intervalMs = routeIntervalMs(route, options);
  if (intervalMs <= 0) {
    return;
  }

  const now = clock.now();
  state.nextAt = now + intervalMs;

  if (context.requestId) {
    console.log(
      `[${new Date().toISOString()}] ${context.requestId} rate-limit-pacing ` +
        `route=${route.id || route.model || "unknown"} next_after_ms=${intervalMs}`,
    );
  }
}

async function waitForProviderCooldown(route, context, options = {}) {
  const key = providerIdentityKey(route);
  while (true) {
    const cooldownUntil = Number(providerCooldowns.get(key) || 0);
    const cooldownRemainingMs = Math.max(0, cooldownUntil - clock.now());
    if (cooldownRemainingMs <= 0) {
      if (providerCooldowns.get(key) === cooldownUntil) {
        providerCooldowns.delete(key);
      }
      return;
    }
    if (options.failFastOnCooldown === true) {
      if (context.requestId) {
        console.log(
          `[${new Date().toISOString()}] ${context.requestId} rate-limit-cooldown ` +
            `route=${route.id || route.model || "unknown"} cooldown_remaining_ms=${cooldownRemainingMs}`,
        );
      }
      throw new RouteRateLimitedError(route, cooldownRemainingMs);
    }
    await clock.sleep(cooldownRemainingMs);
  }
}

async function waitUntil(timestamp) {
  const waitMs = Math.max(0, Number(timestamp || 0) - clock.now());
  if (waitMs > 0) {
    await clock.sleep(waitMs);
  }
}

function routeIntervalMs(route = {}, options = {}) {
  if (!localRateLimitEnabled(route, options)) {
    return 0;
  }
  const rpm = effectiveRouteRpm(route);
  if (!Number.isFinite(rpm) || rpm <= 0) {
    return 0;
  }
  return Math.ceil(60_000 / rpm);
}

function effectiveRouteRpm(route = {}) {
  const nestedRpm = Number(route.rateLimit?.rpm || 0);
  if (Number.isFinite(nestedRpm) && nestedRpm > 0) {
    return nestedRpm;
  }
  if (isLegacyDefaultKimiRpm(route)) {
    return 0;
  }
  return Number(route.rpm || 0);
}

function localRateLimitEnabled(route = {}, options = {}) {
  if (options.rateLimitEnabled === false) {
    return false;
  }
  if (options.rateLimitEnabled === true) {
    return true;
  }
  if (route.localRateLimitEnabled === false || route.rateLimit?.enabled === false) {
    return false;
  }
  if (route.localRateLimitEnabled === true || route.rateLimit?.enabled === true) {
    return true;
  }
  return hasExplicitRoutePacing(route);
}

function hasExplicitRoutePacing(route = {}) {
  const nestedRpm = Number(route.rateLimit?.rpm || 0);
  const directRpm = Number(route.rpm || 0);
  return (
    (Number.isFinite(nestedRpm) && nestedRpm > 0) ||
    (Number.isFinite(directRpm) && directRpm > 0 && !isLegacyDefaultKimiRpm(route))
  );
}

function isLegacyDefaultKimiRpm(route = {}) {
  return Number(route.rpm || 0) === 12 && isKimiRoute(route);
}

function isKimiRoute(route = {}) {
  const provider = String(route.provider || route.providerId || route.providerFamily || "").toLowerCase();
  if (provider.includes("kimi") || provider.includes("moonshot")) {
    return true;
  }
  const baseUrl = String(route.baseUrl || "").toLowerCase();
  const model = String(route.model || route.id || "").toLowerCase();
  return baseUrl.includes("moonshot") || model.includes("kimi");
}

function clampCooldownMs(value, route = {}) {
  const cooldownMs = Math.max(0, Number(value || 0));
  const maxCooldownMs = maxCooldownMsForRoute(route);
  return Math.min(cooldownMs, maxCooldownMs);
}

function maxCooldownMsForRoute(route = {}) {
  const configured = Number(route.maxCooldownMs || route.rateLimit?.maxCooldownMs || 0);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return MAX_429_COOLDOWN_MS;
}

function localPacingStateForRoute(route = {}) {
  const key = providerIdentityKey(route);
  if (!localPacingStates.has(key)) {
    localPacingStates.set(key, {
      queue: Promise.resolve(),
      nextAt: 0,
    });
  }
  return localPacingStates.get(key);
}

function providerIdentityKey(route = {}) {
  const authMode = route.authMode || "api_key";
  const provider = route.provider || route.providerId || "";
  const baseUrl = nonSecretBaseUrl(route.baseUrl);
  const keyRef = route.rateLimitKey || route.apiKeyEnv || route.keyEnv || "";

  if (provider || baseUrl || keyRef) {
    return [authMode, provider, baseUrl, keyRef].join("|");
  }

  return [route.id || "", route.model || ""].join("|");
}

function nonSecretBaseUrl(value) {
  const baseUrl = String(value || "");
  if (!baseUrl) {
    return "";
  }
  try {
    const parsed = new URL(baseUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return baseUrl.split(/[?#]/, 1)[0];
  }
}

function retryAfterMs(headers) {
  const value = headerValue(headers, "retry-after");
  if (!value) {
    return 0;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - clock.now());
  }

  return 0;
}

function headerValue(headers, name) {
  if (!headers) {
    return "";
  }
  if (typeof headers.get === "function") {
    return headers.get(name) || "";
  }
  const lower = name.toLowerCase();
  return headers[name] || headers[lower] || "";
}

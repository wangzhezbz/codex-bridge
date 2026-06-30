const DEFAULT_429_COOLDOWN_MS = 30_000;
const MAX_429_COOLDOWN_MS = 120_000;

const states = new Map();

let clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class RouteRateLimitedError extends Error {
  constructor(route = {}, retryAfterMs = 0) {
    super(
      `Provider is temporarily rate limited for ${route.id || route.model || "this route"}. ` +
        `Retry after ${Math.ceil(Math.max(0, retryAfterMs) / 1000)}s.`,
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
  const state = stateForRoute(route);
  state.queue = state.queue
    .catch(() => {})
    .then(() => reserveRouteCapacity(state, route, context, options));
  return state.queue;
}

export function markRouteRateLimited(route = {}, headers) {
  const state = stateForRoute(route);
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
  state.cooldownUntil = Math.max(state.cooldownUntil || 0, cooldownUntil);
}

export function routeRateLimitStatus(route = {}) {
  const state = states.get(rateLimitKey(route));
  if (!state) {
    return {
      cooldownRemainingMs: 0,
      nextAfterMs: 0,
    };
  }
  const now = clock.now();
  return {
    cooldownRemainingMs: Math.max(0, Number(state.cooldownUntil || 0) - now),
    nextAfterMs: Math.max(0, Number(state.nextAt || 0) - now),
  };
}

export function __setRateLimitClockForTests(nextClock) {
  clock = {
    now: nextClock?.now || clock.now,
    sleep: nextClock?.sleep || clock.sleep,
  };
}

export function __resetRateLimiterForTests() {
  states.clear();
  clock = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

async function reserveRouteCapacity(state, route, context, options = {}) {
  if (options.failFastOnCooldown !== false) {
    const cooldownRemainingMs = Math.max(0, Number(state.cooldownUntil || 0) - clock.now());
    if (cooldownRemainingMs > 0) {
      if (context.requestId) {
        console.log(
          `[${new Date().toISOString()}] ${context.requestId} rate-limit-cooldown ` +
            `route=${route.id || route.model || "unknown"} cooldown_remaining_ms=${cooldownRemainingMs}`,
        );
      }
      throw new RouteRateLimitedError(route, cooldownRemainingMs);
    }
  }
  await waitUntil(state.cooldownUntil || 0);
  await waitUntil(state.nextAt || 0);

  const intervalMs = routeIntervalMs(route);
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

async function waitUntil(timestamp) {
  const waitMs = Math.max(0, Number(timestamp || 0) - clock.now());
  if (waitMs > 0) {
    await clock.sleep(waitMs);
  }
}

function routeIntervalMs(route = {}) {
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

function stateForRoute(route = {}) {
  const key = rateLimitKey(route);
  if (!states.has(key)) {
    states.set(key, {
      queue: Promise.resolve(),
      nextAt: 0,
      cooldownUntil: 0,
    });
  }
  return states.get(key);
}

function rateLimitKey(route = {}) {
  const authMode = route.authMode || "api_key";
  const provider = route.provider || route.providerId || "";
  const baseUrl = route.baseUrl || "";
  const keyRef = route.rateLimitKey || route.apiKeyEnv || route.keyEnv || (route.apiKey ? "inline-api-key" : "");

  if (provider || baseUrl || keyRef) {
    return [authMode, provider, baseUrl, keyRef].join("|");
  }

  return [route.id || "", route.model || ""].join("|");
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

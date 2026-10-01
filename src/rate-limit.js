const DEFAULT_429_COOLDOWN_MS = 30_000;
const MAX_429_COOLDOWN_MS = 120_000;
const HARD_MAX_RATE_LIMIT_WAIT_MS = 24 * 60 * 60_000;
const MAX_RATE_LIMIT_STATES = 2_048;

const providerCooldowns = new Map();
const localPacingStates = new Map();

let clock = {
  now: () => Date.now(),
  sleep: abortableSleep,
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
  throwIfRouteWaitAborted(context.clientSignal);
  await waitForProviderCooldown(route, context, options);
  throwIfRouteWaitAborted(context.clientSignal);
  if (!localRateLimitEnabled(route, options)) {
    return;
  }
  const state = localPacingStateForRoute(route);
  return new Promise((resolve, reject) => {
    const entry = { route, context, options, resolve, reject, onAbort: null };
    entry.onAbort = () => {
      const index = state.queue.indexOf(entry);
      if (index < 0) return; // Active waits have their own abort handling.
      state.queue.splice(index, 1);
      context.clientSignal?.removeEventListener("abort", entry.onAbort);
      reject(routeWaitAbortReason(context.clientSignal));
    };
    context.clientSignal?.addEventListener("abort", entry.onAbort, { once: true });
    state.queue.push(entry);
    drainLocalPacingQueue(state);
  });
}

async function drainLocalPacingQueue(state) {
  if (state.running) return;
  state.running = true;
  try {
    while (state.queue.length) {
      const entry = state.queue.shift();
      try {
        await reserveLocalPacing(state, entry.route, entry.context, entry.options);
        entry.resolve();
      } catch (error) {
        entry.reject(error);
      } finally {
        entry.context.clientSignal?.removeEventListener("abort", entry.onAbort);
      }
    }
  } finally {
    state.running = false;
  }
}

export function markRouteRateLimited(route = {}, headers) {
  const hint = parseRetryAfter(headerValue(headers, "retry-after"), clock.now());
  const fallbackCooldownMs = Math.max(
    Number(route.cooldownMs || 0),
    DEFAULT_429_COOLDOWN_MS,
  );
  // Provider deadlines are a minimum wait, not our bounded fallback policy.
  // Keep the full deadline; individual sleeps remain bounded and abortable.
  const cooldownMs = hint ? hint.delayMs : clampCooldownMs(fallbackCooldownMs, route);
  const cooldownUntil = clock.now() + Math.max(0, cooldownMs);
  const key = providerIdentityKey(route);
  setBoundedState(providerCooldowns,
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
    sleep: abortableSleep,
  };
}

export function __rateLimiterStateSizesForTests() {
  return {
    providerCooldowns: providerCooldowns.size,
    localPacingStates: localPacingStates.size,
  };
}

function abortableSleep(milliseconds, signal = undefined) {
  throwIfRouteWaitAborted(signal);
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(routeWaitAbortReason(signal));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.min(Math.max(0, Number(milliseconds) || 0), HARD_MAX_RATE_LIMIT_WAIT_MS));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function reserveLocalPacing(state, route, context, options = {}) {
  throwIfRouteWaitAborted(context.clientSignal);
  await waitUntil(state.nextAt || 0, context.clientSignal);
  // Another in-flight request may have received 429 while this one was queued.
  await waitForProviderCooldown(route, context, options);
  throwIfRouteWaitAborted(context.clientSignal);

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
    await waitForClockSleep(cooldownRemainingMs, context.clientSignal);
  }
}

async function waitUntil(timestamp, signal = undefined) {
  const waitMs = Math.max(0, Number(timestamp || 0) - clock.now());
  if (waitMs > 0) {
    await waitForClockSleep(waitMs, signal);
  }
}

async function waitForClockSleep(delayMs, signal = undefined) {
  throwIfRouteWaitAborted(signal);
  const boundedDelayMs = Math.min(delayMs, HARD_MAX_RATE_LIMIT_WAIT_MS);
  if (!signal) {
    await clock.sleep(boundedDelayMs);
    return;
  }
  let onAbort = null;
  try {
    await Promise.race([
      Promise.resolve().then(() => clock.sleep(boundedDelayMs, signal)),
      new Promise((_resolve, reject) => {
        onAbort = () => reject(routeWaitAbortReason(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
  throwIfRouteWaitAborted(signal);
}

function throwIfRouteWaitAborted(signal) {
  if (signal?.aborted) {
    throw routeWaitAbortReason(signal);
  }
}

function routeWaitAbortReason(signal) {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("Client disconnected while waiting for route capacity.");
  error.name = "AbortError";
  error.code = "client_closed_request";
  return error;
}

function routeIntervalMs(route = {}, options = {}) {
  if (!localRateLimitEnabled(route, options)) {
    return 0;
  }
  const rpm = effectiveRouteRpm(route);
  if (!Number.isFinite(rpm) || rpm <= 0) {
    return 0;
  }
  return Math.min(Math.ceil(60_000 / rpm), HARD_MAX_RATE_LIMIT_WAIT_MS);
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
    return Math.min(configured, HARD_MAX_RATE_LIMIT_WAIT_MS);
  }
  return MAX_429_COOLDOWN_MS;
}

function localPacingStateForRoute(route = {}) {
  const key = providerIdentityKey(route);
  if (!localPacingStates.has(key)) {
    setBoundedState(localPacingStates, key, {
      queue: [],
      running: false,
      nextAt: 0,
    });
  } else {
    setBoundedState(localPacingStates, key, localPacingStates.get(key));
  }
  return localPacingStates.get(key);
}

function setBoundedState(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_RATE_LIMIT_STATES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
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

export function parseRetryAfter(value, now = Date.now()) {
  const raw = String(value ?? "");
  if (/[\r\n]/.test(raw)) return null;
  const header = raw.trim();
  // Retain compatible providers' existing fractional-second hints as well.
  if (/^\d+(?:\.\d+)?$/.test(header)) {
    const delayMs = Math.ceil(Number(header) * 1000);
    return Number.isFinite(delayMs) ? { value: header, delayMs } : null;
  }
  // Accept HTTP-date's preferred form and its two legacy wire formats, not
  // JavaScript's permissive date strings (e.g. "-1" or "1.5.2").
  const httpDate = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)
    || /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT$/.test(header)
    || /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/.test(header);
  if (!httpDate) return null;
  // HTTP-date is always UTC, including asctime's zone-less legacy syntax.
  const timestamp = Date.parse(header.endsWith(" GMT") ? header : `${header} GMT`);
  return Number.isFinite(timestamp)
    ? { value: header, delayMs: Math.max(0, timestamp - now) }
    : null;
}

function headerValue(headers, name) {
  if (!headers) {
    return "";
  }
  if (typeof headers.get === "function") {
    return headers.get(name) || "";
  }
  const lower = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lower);
  return entry?.[1] ?? "";
}

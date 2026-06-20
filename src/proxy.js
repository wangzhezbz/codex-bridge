import { execFileSync } from "node:child_process";
import { ProxyAgent } from "undici";

const proxyAgents = new Map();
let cachedWindowsProxySettings;

export function fetchInitWithProxy(targetUrl, init = {}) {
  if (init.dispatcher) {
    return init;
  }
  const proxy = proxySettingsForUrl(targetUrl);
  if (!proxy?.url) {
    return init;
  }
  return {
    ...init,
    dispatcher: proxyAgent(proxy.url),
  };
}

export function proxyLogLabel(targetUrl) {
  const proxy = proxySettingsForUrl(targetUrl);
  if (!proxy?.url) {
    return "";
  }
  return `${proxy.source}:${redactProxyUrl(proxy.url)}`;
}

export function proxySettingsForUrl(targetUrl, env = process.env) {
  const parsed = safeUrl(targetUrl);
  if (!parsed || isLocalHost(parsed.hostname)) {
    return null;
  }

  const noProxy = env.NO_PROXY || env.no_proxy || "";
  if (noProxyMatches(parsed.hostname, noProxy)) {
    return null;
  }

  const envProxy = envProxyForProtocol(parsed.protocol, env);
  if (envProxy) {
    return { source: "env", url: normalizeProxyUrl(envProxy) };
  }

  const windowsProxy = windowsProxyForUrl(parsed, env);
  if (windowsProxy) {
    return { source: "windows", url: normalizeProxyUrl(windowsProxy) };
  }

  return null;
}

function proxyAgent(proxyUrl) {
  if (!proxyAgents.has(proxyUrl)) {
    proxyAgents.set(proxyUrl, new ProxyAgent(proxyUrl));
  }
  return proxyAgents.get(proxyUrl);
}

function envProxyForProtocol(protocol, env) {
  const isHttps = protocol === "https:";
  const candidates = isHttps
    ? [
        "CODEXBRIDGE_HTTPS_PROXY",
        "HTTPS_PROXY",
        "https_proxy",
        "CODEXBRIDGE_ALL_PROXY",
        "ALL_PROXY",
        "all_proxy",
        "CODEXBRIDGE_HTTP_PROXY",
        "HTTP_PROXY",
        "http_proxy",
      ]
    : [
        "CODEXBRIDGE_HTTP_PROXY",
        "HTTP_PROXY",
        "http_proxy",
        "CODEXBRIDGE_ALL_PROXY",
        "ALL_PROXY",
        "all_proxy",
      ];
  for (const key of candidates) {
    const value = env[key];
    if (value && String(value).trim()) {
      return value;
    }
  }
  return "";
}

function windowsProxyForUrl(parsedUrl, env) {
  if (env.CODEXBRIDGE_DISABLE_SYSTEM_PROXY === "1" || process.platform !== "win32") {
    return "";
  }
  const settings = readWindowsProxySettings();
  if (!settings.enabled || !settings.server) {
    return "";
  }
  if (noProxyMatches(parsedUrl.hostname, settings.override)) {
    return "";
  }
  return proxyFromWindowsServer(settings.server, parsedUrl.protocol);
}

function readWindowsProxySettings() {
  if (cachedWindowsProxySettings) {
    return cachedWindowsProxySettings;
  }
  const empty = { enabled: false, server: "", override: "" };
  try {
    const output = execFileSync(
      "reg",
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    const proxyEnable = readRegValue(output, "ProxyEnable");
    const proxyServer = readRegValue(output, "ProxyServer");
    const proxyOverride = readRegValue(output, "ProxyOverride");
    cachedWindowsProxySettings = {
      enabled: isRegDwordEnabled(proxyEnable),
      server: proxyServer,
      override: proxyOverride,
    };
    return cachedWindowsProxySettings;
  } catch {
    cachedWindowsProxySettings = empty;
    return cachedWindowsProxySettings;
  }
}

function readRegValue(output, name) {
  const pattern = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, "im");
  const match = output.match(pattern);
  return match ? match[1].trim() : "";
}

function isRegDwordEnabled(value) {
  const clean = String(value || "").trim().toLowerCase();
  return clean === "1" || clean === "0x1";
}

function proxyFromWindowsServer(proxyServer, protocol) {
  const server = String(proxyServer || "").trim();
  if (!server) {
    return "";
  }
  if (!server.includes("=")) {
    return server;
  }
  const entries = new Map();
  for (const part of server.split(";")) {
    const [key, ...rest] = part.split("=");
    const value = rest.join("=").trim();
    if (key && value) {
      entries.set(key.trim().toLowerCase(), value);
    }
  }
  const protocolKey = protocol === "https:" ? "https" : "http";
  return entries.get(protocolKey) || entries.get("http") || entries.get("socks") || "";
}

function normalizeProxyUrl(value) {
  const clean = String(value || "").trim();
  if (!clean) {
    return "";
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) {
    return clean;
  }
  return `http://${clean}`;
}

function redactProxyUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "***";
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(value).replace(/\/\/[^:@\s]+:[^@\s]+@/, "//***:***@");
  }
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    host.startsWith("127.")
  );
}

function noProxyMatches(hostname, noProxy) {
  const host = String(hostname || "").toLowerCase();
  const rules = String(noProxy || "")
    .split(/[;,]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  for (let rule of rules) {
    if (rule === "*") {
      return true;
    }
    if (rule === "<local>" && !host.includes(".")) {
      return true;
    }
    rule = rule.replace(/^\*\./, ".");
    const ruleHost = rule.includes(":") ? rule.split(":")[0] : rule;
    if (ruleHost.startsWith(".")) {
      if (host.endsWith(ruleHost) || host === ruleHost.slice(1)) {
        return true;
      }
      continue;
    }
    if (host === ruleHost || host.endsWith(`.${ruleHost}`)) {
      return true;
    }
  }
  return false;
}

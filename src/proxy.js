import { execFileSync } from "node:child_process";
import { ProxyAgent } from "undici";

const proxyAgents = new Map();
let cachedWindowsProxySettings;
let cachedMacosProxySettings;

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

export function proxySettingsForUrl(targetUrl, env = process.env, options = {}) {
  const parsed = safeUrl(targetUrl);
  if (!parsed || isLocalHost(parsed.hostname)) {
    return null;
  }
  const platform = options.platform || process.platform;

  const noProxy = env.NO_PROXY || env.no_proxy || "";
  if (noProxyMatches(parsed.hostname, noProxy)) {
    return null;
  }

  const envProxy = envProxyForProtocol(parsed.protocol, env);
  if (envProxy) {
    return { source: "env", url: normalizeProxyUrl(envProxy) };
  }

  const windowsProxy = windowsProxyForUrl(parsed, env, platform);
  if (windowsProxy) {
    return { source: "windows", url: normalizeProxyUrl(windowsProxy) };
  }

  const macosProxy = macosProxyForUrl(parsed, env, platform, options);
  if (macosProxy) {
    return { source: "macos", url: normalizeProxyUrl(macosProxy) };
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

function windowsProxyForUrl(parsedUrl, env, platform = process.platform) {
  if (env.CODEXBRIDGE_DISABLE_SYSTEM_PROXY === "1" || platform !== "win32") {
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

function macosProxyForUrl(parsedUrl, env, platform = process.platform, options = {}) {
  if (env.CODEXBRIDGE_DISABLE_SYSTEM_PROXY === "1" || platform !== "darwin") {
    return "";
  }
  const settings = options.macosProxySettings || readMacosProxySettings();
  if (!settings) {
    return "";
  }
  if (noProxyMatches(parsedUrl.hostname, settings.exceptions?.join(",") || "")) {
    return "";
  }
  if (parsedUrl.protocol === "https:" && settings.httpsEnable && settings.httpsProxy) {
    return proxyFromHostPort(settings.httpsProxy, settings.httpsPort);
  }
  if (parsedUrl.protocol === "http:" && settings.httpEnable && settings.httpProxy) {
    return proxyFromHostPort(settings.httpProxy, settings.httpPort);
  }
  return "";
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

function readMacosProxySettings() {
  if (cachedMacosProxySettings) {
    return cachedMacosProxySettings;
  }
  try {
    const output = execFileSync("scutil", ["--proxy"], {
      encoding: "utf8",
      windowsHide: true,
    });
    cachedMacosProxySettings = parseMacosProxySettings(output);
    return cachedMacosProxySettings;
  } catch {
    cachedMacosProxySettings = {
      httpEnable: false,
      httpProxy: "",
      httpPort: 0,
      httpsEnable: false,
      httpsProxy: "",
      httpsPort: 0,
      exceptions: [],
    };
    return cachedMacosProxySettings;
  }
}

function parseMacosProxySettings(output) {
  const text = String(output || "");
  return {
    httpEnable: readScutilBoolean(text, "HTTPEnable"),
    httpProxy: readScutilValue(text, "HTTPProxy"),
    httpPort: readScutilInteger(text, "HTTPPort"),
    httpsEnable: readScutilBoolean(text, "HTTPSEnable"),
    httpsProxy: readScutilValue(text, "HTTPSProxy"),
    httpsPort: readScutilInteger(text, "HTTPSPort"),
    exceptions: readScutilExceptions(text),
  };
}

function readScutilValue(output, name) {
  const pattern = new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, "im");
  const match = output.match(pattern);
  return match ? match[1].trim() : "";
}

function readScutilInteger(output, name) {
  return Number(readScutilValue(output, name) || 0) || 0;
}

function readScutilBoolean(output, name) {
  return readScutilInteger(output, name) === 1;
}

function readScutilExceptions(output) {
  const exceptions = [];
  const block = String(output || "").match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)^\s*\}/m);
  if (block) {
    for (const line of block[1].split(/\r?\n/)) {
      const match = line.match(/^\s*\d+\s*:\s*(.+?)\s*$/);
      if (match?.[1]) {
        exceptions.push(match[1].trim());
      }
    }
  }
  if (readScutilBoolean(output, "ExcludeSimpleHostnames")) {
    exceptions.push("<local>");
  }
  return exceptions;
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
  return entries.get(protocolKey) || entries.get("http") || "";
}

function proxyFromHostPort(host, port) {
  const cleanHost = String(host || "").trim();
  const cleanPort = Number(port || 0);
  if (!cleanHost) {
    return "";
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(cleanHost)) {
    return cleanHost;
  }
  return cleanPort > 0 ? `${cleanHost}:${cleanPort}` : cleanHost;
}

function normalizeProxyUrl(value) {
  const clean = String(value || "").trim();
  if (!clean) {
    return "";
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) {
    return isSupportedProxyUrl(clean) ? clean : "";
  }
  return `http://${clean}`;
}

function isSupportedProxyUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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

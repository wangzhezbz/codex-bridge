"use strict";

function shouldDisableChromiumSandbox({
  env = process.env,
  platform = process.platform,
} = {}) {
  void platform;
  if (env.CODEXBRIDGE_CHROMIUM_SANDBOX === "1") {
    return false;
  }
  return env.CODEXBRIDGE_NO_SANDBOX === "1";
}

function isTrustedRendererUrl(value, trustedRendererUrl) {
  try {
    const candidate = new URL(String(value || ""));
    const trusted = new URL(String(trustedRendererUrl || ""));
    candidate.hash = "";
    trusted.hash = "";
    return candidate.href === trusted.href;
  } catch {
    return false;
  }
}

function installRendererNavigationGuards(webContents, {
  trustedRendererUrl,
  onBlocked = () => {},
} = {}) {
  if (!webContents || typeof webContents.on !== "function") {
    throw new TypeError("A WebContents event target is required.");
  }
  if (typeof webContents.setWindowOpenHandler !== "function") {
    throw new TypeError("WebContents must support setWindowOpenHandler.");
  }

  const blockUntrustedNavigation = (kind) => (event, targetUrl) => {
    if (isTrustedRendererUrl(targetUrl, trustedRendererUrl)) {
      return;
    }
    event.preventDefault();
    onBlocked({ kind, url: String(targetUrl || "") });
  };

  webContents.on("will-navigate", blockUntrustedNavigation("navigation"));
  webContents.on("will-redirect", blockUntrustedNavigation("redirect"));
  webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
    onBlocked({ kind: "webview", url: "" });
  });
  webContents.setWindowOpenHandler((details = {}) => {
    onBlocked({ kind: "window-open", url: String(details.url || "") });
    return { action: "deny" };
  });
}

function isTrustedIpcSender(event, {
  trustedWebContents,
  trustedRendererUrl,
} = {}) {
  return Boolean(
    trustedWebContents &&
    event?.sender === trustedWebContents &&
    isTrustedRendererUrl(event?.senderFrame?.url, trustedRendererUrl),
  );
}

function createTrustedIpcRegistrar(rawIpcMain, getSecurityContext) {
  if (!rawIpcMain || typeof rawIpcMain.handle !== "function") {
    throw new TypeError("ipcMain.handle is required.");
  }
  if (typeof getSecurityContext !== "function") {
    throw new TypeError("A security context provider is required.");
  }

  return {
    handle(channel, listener) {
      if (typeof listener !== "function") {
        throw new TypeError("An IPC listener is required.");
      }
      return rawIpcMain.handle(channel, (event, ...args) => {
        if (!isTrustedIpcSender(event, getSecurityContext())) {
          const error = new Error("Untrusted IPC sender.");
          error.code = "ERR_UNTRUSTED_IPC_SENDER";
          throw error;
        }
        return listener(event, ...args);
      });
    },
  };
}

module.exports = {
  createTrustedIpcRegistrar,
  installRendererNavigationGuards,
  isTrustedIpcSender,
  isTrustedRendererUrl,
  shouldDisableChromiumSandbox,
};

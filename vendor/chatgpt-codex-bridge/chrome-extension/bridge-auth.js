(() => {
  function authorizedHeaders(headers = {}) {
    const authorized = { ...headers };
    const authToken = String(globalThis.CODEX_BRIDGE_CONFIG?.authToken || "").trim();
    if (authToken) {
      authorized["X-CodexBridge-Token"] = authToken;
    }
    return authorized;
  }

  globalThis.CODEX_BRIDGE_AUTH = Object.freeze({ authorizedHeaders });
})();

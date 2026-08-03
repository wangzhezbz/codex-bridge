export function createBridgeApiClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const configPath = options.configPath || "/api/config";
  const scopeToken = String(options.scopeToken || "");
  let apiToken = String(options.apiToken || "");
  let tokenPromise = null;

  function isMutation(method = "GET") {
    return ["POST", "PATCH", "PUT", "DELETE"].includes(String(method || "GET").toUpperCase());
  }

  async function loadToken(force = false) {
    if (!force && apiToken) {
      return apiToken;
    }
    if (force) {
      apiToken = "";
    }
    if (!tokenPromise) {
      tokenPromise = fetchImpl(configPath, {
        headers: {
          "Content-Type": "application/json",
          ...(scopeToken ? { "X-Bridge-Scope": scopeToken } : {})
        },
        cache: "no-store"
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Bridge API token bootstrap failed with status ${response.status}`);
          }
          const config = await response.json();
          apiToken = String(config?.apiToken || "");
          if (!apiToken) {
            throw new Error("Bridge API token bootstrap returned no token");
          }
          return apiToken;
        })
        .finally(() => {
          tokenPromise = null;
        });
    }
    return tokenPromise;
  }

  return {
    async fetch(path, requestOptions = {}) {
      const mutation = isMutation(requestOptions.method);
      const request = (token) =>
        fetchImpl(path, {
          ...requestOptions,
          headers: {
            ...(requestOptions.headers || {}),
            ...(scopeToken ? { "X-Bridge-Scope": scopeToken } : {}),
            ...(token ? { "X-Bridge-Token": token } : {})
          }
        });
      let response = await request(mutation ? await loadToken() : apiToken);
      if (mutation && response.status === 401) {
        response = await request(await loadToken(true));
      }
      return response;
    }
  };
}

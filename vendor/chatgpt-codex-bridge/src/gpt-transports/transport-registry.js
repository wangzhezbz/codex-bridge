const REQUIRED_METHODS = ["submitText", "submitArtifacts", "wait", "cancel"];

function normalizeTransportId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) {
    throw new Error("GPT transport id is required");
  }
  return id;
}
function validateTransport(transport) {
  if (!transport || typeof transport !== "object") {
    throw new Error("GPT transport must be an object");
  }

  const id = normalizeTransportId(transport.id);
  for (const method of REQUIRED_METHODS) {
    if (typeof transport[method] !== "function") {
      throw new Error(`GPT transport ${id} must implement ${method}()`);
    }
  }
  return id;
}

export function createGptTransportRegistry(options = {}) {
  const transports = new Map();
  const env = options.env || process.env;
  const defaultTransportId = normalizeTransportId(options.defaultTransportId || "web-sync");

  function register(transport, registerOptions = {}) {
    const id = validateTransport(transport);
    if (transports.has(id) && registerOptions.replace !== true) {
      throw new Error(`GPT transport is already registered: ${id}`);
    }
    transports.set(id, transport);
    return transport;
  }

  for (const transport of options.transports || []) {
    register(transport);
  }

  function resolve(requestedId) {
    const id = normalizeTransportId(requestedId || env.BRIDGE_GPT_TRANSPORT || defaultTransportId);
    const transport = transports.get(id);
    if (!transport) {
      throw new Error(`GPT transport is not registered: ${id}`);
    }
    return transport;
  }

  return {
    register,
    resolve,
    has(id) {
      return transports.has(normalizeTransportId(id));
    },
    list() {
      return [...transports.values()];
    }
  };
}

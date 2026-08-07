function shortcutApiError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireMethod(owner, name, code) {
  if (!owner || typeof owner[name] !== "function") throw shortcutApiError(code);
  return owner[name].bind(owner);
}

export function createLazyShortcutFileApi({ getDesktopCapability, fileCapabilities } = {}) {
  const getCapability = requireMethod(
    { getDesktopCapability }, "getDesktopCapability", "desktop_capability_provider_required",
  );
  const createApi = requireMethod(
    fileCapabilities, "createShortcutFileApi", "shortcut_file_capability_invalid",
  );
  const methods = [
    "inspectExact", "createTemp", "sealTemp", "commitNoReplace",
    "removeTemp", "removeExact", "release",
  ];
  let apiPromise = null;
  async function getApi() {
    if (apiPromise === null) {
      const operation = Promise.resolve().then(getCapability).then(createApi);
      apiPromise = operation;
      operation.catch(() => {
        if (apiPromise === operation) apiPromise = null;
      });
    }
    return apiPromise;
  }
  return Object.freeze(Object.fromEntries(methods.map((name) => [name, async (...args) => {
    const api = await getApi();
    return requireMethod(api, name, "shortcut_file_capability_invalid")(...args);
  }])));
}

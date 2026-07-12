const MODE_PREFERENCES = new Set(["fast", "balanced", "advanced", "high", "pro"]);
const MODEL_PREFERENCES = new Set(["gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.3", "o3"]);
const MODEL_MODE_PREFERENCES = {
  "gpt-5.6-sol": ["fast", "balanced", "advanced", "high", "pro"],
  "gpt-5.5": ["fast", "balanced", "advanced", "high", "pro"],
  "gpt-5.4": ["fast", "balanced", "advanced", "high", "pro"],
  "gpt-5.3": ["fast"],
  o3: []
};

function normalizePreference(value) {
  const text = String(value || "").trim();
  return text || null;
}

export function modelSupportsModePreference(modelPreference) {
  const model = normalizePreference(modelPreference);
  return modePreferencesForModel(model).length > 0;
}

export function modePreferencesForModel(modelPreference) {
  const model = normalizePreference(modelPreference);
  return MODEL_MODE_PREFERENCES[model] || [];
}

export function compatibleModePreference(modelPreference, modePreference) {
  const mode = normalizePreference(modePreference);
  const allowedModes = modePreferencesForModel(modelPreference);

  if (!allowedModes.length) {
    return modelPreference ? null : MODE_PREFERENCES.has(mode) ? mode : null;
  }
  if (!MODE_PREFERENCES.has(mode)) {
    return null;
  }
  return allowedModes.includes(mode) ? mode : allowedModes[0];
}

export function normalizeChatGptPreferences(input = {}) {
  const model = normalizePreference(input.modelPreference);
  const mode = normalizePreference(input.modePreference);
  const modelPreference = MODEL_PREFERENCES.has(model) ? model : null;
  const modePreference = MODE_PREFERENCES.has(mode) ? mode : null;

  return {
    modePreference: modelPreference ? compatibleModePreference(modelPreference, modePreference) : modePreference,
    modelPreference
  };
}

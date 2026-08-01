export function normalizeBridgeHttpUrl(raw = "") {
  const value = String(raw || "").trim();
  if (!value || /[\u0000-\u001f\s]/.test(value) || value.includes("\\") || value.includes("@")) {
    return "";
  }
  const parsedDirect = parseAllowedBridgeHttpUrl(value);
  if (parsedDirect) {
    return parsedDirect;
  }
  if (!looksLikeBareBridgeHttpUrl(value)) {
    return "";
  }
  return parseAllowedBridgeHttpUrl(`https://${value}`);
}

function parseAllowedBridgeHttpUrl(value = "") {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function looksLikeBareBridgeHttpUrl(value = "") {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/") || value.startsWith("//")) {
    return false;
  }
  const host = String(value).split(/[/?#]/, 1)[0];
  if (!host || host.includes("..")) {
    return false;
  }
  const hostname = host.split(":", 1)[0];
  if (hostname === "localhost" || isBridgeIpv4(hostname)) {
    return true;
  }
  return hostname.includes(".") && hostname
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function isBridgeIpv4(value = "") {
  const parts = String(value).split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const numeric = Number(part);
    return numeric >= 0 && numeric <= 255;
  });
}

import { joinUpstreamUrl } from "./config.js";

export function createUpstreamUrlFallbackPolicy({ UpstreamHttpError }) {
  function chatCompletionsV1FallbackUrl(route, upstreamUrl, error) {
    if (!isHtmlNonJsonError(error) || !isRootBaseUrl(route?.baseUrl)) {
      return "";
    }
    return chatCompletionsRootFallbackUrl(route, upstreamUrl);
  }

  function chatCompletionsRootFallbackUrl(route, upstreamUrl) {
    if (!isRootBaseUrl(route?.baseUrl)) {
      return "";
    }
    const fallbackBaseUrl = baseUrlWithV1Path(route.baseUrl);
    if (!fallbackBaseUrl) {
      return "";
    }
    const fallbackUrl = joinUpstreamUrl(fallbackBaseUrl, "/chat/completions");
    return fallbackUrl === upstreamUrl ? "" : fallbackUrl;
  }

  function responsesV1FallbackUrl(route, upstreamUrl, upstreamPath = "/responses") {
    if (!isRootBaseUrl(route?.baseUrl)) {
      return "";
    }
    const fallbackBaseUrl = baseUrlWithV1Path(route.baseUrl);
    if (!fallbackBaseUrl) {
      return "";
    }
    const fallbackUrl = joinUpstreamUrl(fallbackBaseUrl, upstreamPath);
    return fallbackUrl === upstreamUrl ? "" : fallbackUrl;
  }

  function isHtmlNonJsonError(error) {
    return (
      error instanceof UpstreamHttpError &&
      error.statusCode === 502 &&
      /Upstream returned non-JSON body:/i.test(error.bodyText || "") &&
      /<(!doctype\s+html|html|head|body)(\s|>|$)/i.test(error.bodyText || "")
    );
  }

  return {
    chatCompletionsRootFallbackUrl,
    chatCompletionsV1FallbackUrl,
    responsesV1FallbackUrl,
    upstreamResponseLooksHtml,
  };
}

function upstreamResponseLooksHtml(response) {
  return /(?:^|;|\s)text\/html(?:;|\s|$)/i.test(
    response?.headers?.get?.("content-type") || "",
  );
}

function isRootBaseUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return parsed.pathname === "" || parsed.pathname === "/";
  } catch {
    return false;
  }
}

function baseUrlWithV1Path(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    parsed.pathname = "/v1";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

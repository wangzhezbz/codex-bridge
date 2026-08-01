import { normalizeBridgeHttpUrl } from "./bridge-capability-url.js";
import { tryParseJson } from "./json.js";

export function parseBridgeCapabilityToolCall(toolCall = {}) {
  const rawArgs = toolCall?.function?.arguments ?? toolCall?.arguments ?? {};
  const args = typeof rawArgs === "string" ? tryParseJson(rawArgs) : rawArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {
      ok: false,
      error: new Error("codexbridge_capability arguments must be a JSON object."),
    };
  }
  const capability = String(args.capability || "").trim().toLowerCase();
  const action = String(args.action || args.input?.action || "").trim().toLowerCase();
  const input = args.input && typeof args.input === "object" && !Array.isArray(args.input)
    ? { ...args.input }
    : {};
  if (capability === "browser" && action === "read_url") {
    const url = normalizeBridgeHttpUrl(input.url || args.url || "");
    if (!url) {
      return {
        ok: false,
        error: new Error("browser/read_url only accepts http/https URLs or safe bare domains."),
      };
    }
    input.url = url;
    input.action = "read_url";
    return {
      ok: true,
      request: {
        capability: "browser",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "browser" && action === "open_url") {
    const url = normalizeBridgeHttpUrl(input.url || args.url || "");
    if (!url) {
      return {
        ok: false,
        error: new Error("browser/open_url only accepts http/https URLs or safe bare domains."),
      };
    }
    input.url = url;
    input.action = "open_url";
    return {
      ok: true,
      request: {
        capability: "browser",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "computer_use" && action === "list_apps") {
    input.action = "list_apps";
    return {
      ok: true,
      request: {
        capability: "computer_use",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "computer_use" && action === "open_app") {
    const app = String(
      input.app ||
        input.application ||
        input.appId ||
        input.app_id ||
        input.name ||
        input.target ||
        args.app ||
        args.application ||
        args.appId ||
        args.app_id ||
        args.name ||
        args.target ||
        "",
    ).trim();
    if (!app) {
      return {
        ok: false,
        error: new Error("computer_use/open_app requires an allowlisted app name."),
      };
    }
    input.app = app;
    input.action = "open_app";
    return {
      ok: true,
      request: {
        capability: "computer_use",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "computer_use" && action === "screenshot_desktop") {
    const displayId = String(input.displayId || input.display_id || args.displayId || args.display_id || "").trim();
    input.action = "screenshot_desktop";
    if (displayId) {
      input.displayId = displayId;
    }
    return {
      ok: true,
      request: {
        capability: "computer_use",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "web_search" && action === "search") {
    const query = String(input.query || args.query || "").trim();
    if (!query) {
      return {
        ok: false,
        error: new Error("web_search/search requires a non-empty query."),
      };
    }
    input.query = query;
    input.action = "search";
    return {
      ok: true,
      request: {
        capability: "web_search",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "webpage_screenshot" && action === "screenshot_url") {
    const url = normalizeBridgeHttpUrl(input.url || args.url || "");
    if (!url) {
      return {
        ok: false,
        error: new Error("webpage_screenshot/screenshot_url only accepts http/https URLs or safe bare domains."),
      };
    }
    input.url = url;
    input.action = "screenshot_url";
    return {
      ok: true,
      request: {
        capability: "webpage_screenshot",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "ocr" && action === "extract_text") {
    const imageUrl = normalizeBridgeHttpUrl(
      input.imageUrl ||
        input.image_url ||
        input.url ||
        args.imageUrl ||
        args.image_url ||
        args.url ||
        "",
    );
    if (!imageUrl) {
      return {
        ok: false,
        error: new Error("ocr/extract_text only accepts http/https image URLs or safe bare domains."),
      };
    }
    input.imageUrl = imageUrl;
    input.action = "extract_text";
    return {
      ok: true,
      request: {
        capability: "ocr",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "file_processing" && (action === "extract_text" || action === "inspect_file")) {
    const rawFileUrl =
      input.fileUrl ||
      input.file_url ||
      input.url ||
      args.fileUrl ||
      args.file_url ||
      args.url ||
      "";
    const fileUrl = normalizeBridgeHttpUrl(
      rawFileUrl,
    );
    const localPath = String(
      input.path ||
        input.filePath ||
        input.file_path ||
        input.localPath ||
        input.local_path ||
        args.path ||
        args.filePath ||
        args.file_path ||
        args.localPath ||
        args.local_path ||
        "",
    ).trim();
    if (localPath && !fileUrl) {
      input.path = localPath;
      input.action = action;
      return {
        ok: true,
        request: {
          capability: "file_processing",
          providerId: String(args.providerId || args.provider_id || "").trim(),
          input,
        },
      };
    }
    if (String(rawFileUrl || "").trim() && !fileUrl) {
      return {
        ok: false,
        error: new Error(`file_processing/${action} only accepts http/https file URLs or safe bare domains.`),
      };
    }
    if (!fileUrl) {
      return {
        ok: false,
        error: new Error(
          `file_processing/${action} only accepts http/https file URLs, safe bare domains, or an explicit local file path for a local_file provider.`,
        ),
      };
    }
    input.fileUrl = fileUrl;
    input.action = action;
    return {
      ok: true,
      request: {
        capability: "file_processing",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "speech" && action === "synthesize") {
    const text = String(input.text || input.prompt || args.text || args.prompt || "").trim();
    if (!text) {
      return {
        ok: false,
        error: new Error("speech/synthesize requires non-empty text."),
      };
    }
    input.text = text;
    input.action = "synthesize";
    return {
      ok: true,
      request: {
        capability: "speech",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "video" && action === "generate") {
    const prompt = String(input.prompt || input.text || args.prompt || args.text || "").trim();
    if (!prompt) {
      return {
        ok: false,
        error: new Error("video/generate requires a non-empty prompt."),
      };
    }
    input.prompt = prompt;
    input.action = "generate";
    return {
      ok: true,
      request: {
        capability: "video",
        providerId: String(args.providerId || args.provider_id || "").trim(),
        input,
      },
    };
  }
  if (capability === "computer_use") {
    return {
      ok: false,
      error: new Error(
        "本地 Computer Use 的 CodexBridge 中转层目前只支持 computer_use/list_apps 查看白名单、computer_use/open_app 打开白名单应用，" +
          "以及 computer_use/screenshot_desktop 获取桌面截图；不会执行点击、键盘输入、拖拽、任意命令或脚本。 " +
          "如果需要完整的原生 Computer Use，请切换到 GPT/OpenAI Responses 路由。",
      ),
    };
  }
  return {
    ok: false,
    error: new Error(
      "codexbridge_capability only supports browser/read_url, browser/open_url, computer_use/list_apps, computer_use/open_app, computer_use/screenshot_desktop, web_search/search, webpage_screenshot/screenshot_url, ocr/extract_text, file_processing/extract_text, file_processing/inspect_file, speech/synthesize, and video/generate.",
    ),
  };
}

if (typeof importScripts === "function") {
  importScripts("bridge-config.js");
}

const DEFAULT_BRIDGE_ORIGIN = String(globalThis.CODEX_BRIDGE_CONFIG?.origin || "").replace(/\/+$/, "");
const DEFAULT_TIMEOUT_MS = 60000;

const watches = new Map();

function watchId() {
  return `watch_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function basename(value = "") {
  return value.split(/[\\/]/).filter(Boolean).at(-1) || "";
}

function normalized(value = "") {
  return value.toLowerCase().trim();
}

function matchesExpectedFilename(item, expectedFilename) {
  if (!expectedFilename) {
    return true;
  }

  const expected = normalized(expectedFilename);
  const actualName = normalized(basename(item.filename || ""));
  const actualUrl = normalized(item.finalUrl || item.url || "");
  return actualName === expected || actualName.includes(expected) || actualUrl.includes(expected);
}

function filenameFromUrl(value = "") {
  try {
    const url = new URL(value);
    if (url.pathname.includes("/interpreter/download")) {
      const sandboxPath = url.searchParams.get("sandbox_path");
      if (sandboxPath) {
        return basename(decodeURIComponent(sandboxPath));
      }
    }
    const fn = url.searchParams.get("fn");
    if (fn) {
      return decodeURIComponent(fn);
    }
    return basename(decodeURIComponent(url.pathname));
  } catch {
    return null;
  }
}

function filenameFromContentDisposition(value = "") {
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value);
  if (encoded?.[1]) {
    try {
      return basename(decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, "")));
    } catch {
      return basename(encoded[1].trim().replace(/^"|"$/g, ""));
    }
  }

  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(value);
  if (quoted?.[1]) {
    return basename(quoted[1].trim());
  }

  const plain = /filename\s*=\s*([^;]+)/i.exec(value);
  if (plain?.[1]) {
    return basename(plain[1].trim().replace(/^"|"$/g, ""));
  }

  return null;
}

function isChatGptContentUrl(value = "") {
  try {
    const url = new URL(value);
    return (
      url.hostname === "chatgpt.com" &&
      (url.pathname.includes("/backend-api/estuary/content") || url.pathname.includes("/interpreter/download"))
    );
  } catch {
    return false;
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

function finishWatch(watch, result) {
  if (watch.done) {
    return;
  }

  watch.done = true;
  watch.result = result;
  clearTimeout(watch.timer);

  for (const waiter of watch.waiters) {
    waiter(result);
  }
  watch.waiters = [];

  const cleanupTimer = setTimeout(() => watches.delete(watch.id), 120000);
  cleanupTimer.unref?.();
}

function failWatch(watch, error) {
  finishWatch(watch, {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  });
}

async function importDownloadedItem(watch, item) {
  const response = await fetch(`${watch.bridgeOrigin}/api/downloads/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      syncJobId: watch.syncJobId || null,
      localPath: item.filename,
      filename: basename(item.filename) || watch.expectedFilename || "gpt-artifact",
      contentType: item.mime || "application/octet-stream",
      originalUrl: item.finalUrl || item.url || null
    })
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

async function importFetchedItem(watch, item) {
  const response = await fetch(`${watch.bridgeOrigin}/api/downloads/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      syncJobId: watch.syncJobId || null,
      filename: item.filename || watch.expectedFilename || "gpt-artifact",
      contentType: item.mime || "application/octet-stream",
      originalUrl: item.url || null,
      base64Data: item.base64Data
    })
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

async function completeDownloadWatch(watch, item) {
  try {
    const imported = await importDownloadedItem(watch, item);
    await cleanupChromeDownloadHistory(watch, item);
    finishWatch(watch, {
      ok: true,
      artifact: imported.artifact,
      download: {
        id: item.id,
        filename: item.filename,
        url: item.finalUrl || item.url || null
      }
    });
  } catch (error) {
    await cleanupChromeDownloadHistory(watch, item);
    failWatch(watch, error);
  }
}

async function completeContentUrlWatch(watch, url) {
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) {
      throw new Error(`GPT content fetch failed with status ${response.status}`);
    }
    const imported = await importFetchedItem(watch, {
      filename: filenameFromUrl(url) || watch.expectedFilename || "gpt-artifact",
      mime: response.headers?.get("content-type") || "application/octet-stream",
      url: response.url || url,
      base64Data: arrayBufferToBase64(await response.arrayBuffer())
    });
    finishWatch(watch, {
      ok: true,
      artifact: imported.artifact,
      download: {
        id: null,
        filename: imported.artifact?.filename || watch.expectedFilename || null,
        url: response.url || url
      }
    });
  } catch (error) {
    failWatch(watch, error);
  }
}

async function completeDirectUrlWatch(watch, url, options = {}) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`GPT direct download failed with status ${response.status}`);
  }

  const imported = await importFetchedItem(watch, {
    filename: options.filename || filenameFromUrl(response.url || url) || watch.expectedFilename || "gpt-artifact",
    mime: response.headers?.get("content-type") || options.contentType || "application/octet-stream",
    url: response.url || url,
    base64Data: arrayBufferToBase64(await response.arrayBuffer())
  });

  finishWatch(watch, {
    ok: true,
    artifact: imported.artifact,
    download: {
      id: null,
      filename: imported.artifact?.filename || options.filename || watch.expectedFilename || null,
      url: response.url || url
    }
  });
}

function claimDownloadForWatch(item) {
  for (const watch of watches.values()) {
    if (watch.done || watch.downloadId) {
      continue;
    }
    if (!matchesExpectedFilename(item, watch.expectedFilename)) {
      continue;
    }
    watch.downloadId = item.id;
    return watch;
  }

  return null;
}

function claimContentUrlForWatch(tabId, url) {
  if (!isChatGptContentUrl(url)) {
    return null;
  }

  const filename = filenameFromUrl(url) || "";
  for (const watch of watches.values()) {
    if (watch.done || watch.contentUrl) {
      continue;
    }
    if (watch.tabId && tabId && watch.tabId !== tabId) {
      continue;
    }
    if (!matchesExpectedFilename({ filename, url }, watch.expectedFilename)) {
      continue;
    }
    watch.contentUrl = url;
    return watch;
  }

  return null;
}

function startDownloadWatch(input = {}) {
  if (!chrome.downloads) {
    throw new Error("Chrome downloads permission is unavailable");
  }

  const id = watchId();
  const watch = {
    id,
    bridgeOrigin: input.bridgeOrigin || DEFAULT_BRIDGE_ORIGIN,
    syncJobId: input.syncJobId || null,
    expectedFilename: input.expectedFilename || null,
    tabId: input.tabId || null,
    url: input.url || null,
    contentType: input.contentType || null,
    createdAt: Date.now(),
    downloadId: null,
    contentUrl: null,
    done: false,
    result: null,
    waiters: [],
    timer: null
  };

  watch.timer = setTimeout(() => {
    completeDownloadWatchFromRecentSearch(watch).then(
      (recovered) => {
        if (!recovered && !watch.done) {
          failWatch(watch, `Timed out waiting for Chrome download ${watch.expectedFilename || ""}`.trim());
        }
      },
      () => {
        if (!watch.done) {
          failWatch(watch, `Timed out waiting for Chrome download ${watch.expectedFilename || ""}`.trim());
        }
      }
    );
  }, input.timeoutMs || DEFAULT_TIMEOUT_MS);
  watch.timer.unref?.();

  watches.set(id, watch);
  return { ok: true, watchId: id };
}

function awaitDownloadWatch(id, sendResponse) {
  const watch = watches.get(id);
  if (!watch) {
    sendResponse({ ok: false, error: "Unknown download watch" });
    return;
  }

  if (watch.done) {
    sendResponse(watch.result);
    return;
  }

  watch.waiters.push(sendResponse);
}

function waitForWatch(watch) {
  if (watch.done) {
    return Promise.resolve(watch.result);
  }

  return new Promise((resolve) => {
    watch.waiters.push(resolve);
  });
}

function chromeDownload(downloadOptions) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(downloadOptions, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!downloadId) {
        reject(new Error("Chrome did not create a download"));
        return;
      }
      resolve(downloadId);
    });
  });
}

function searchChromeDownload(query) {
  return new Promise((resolve, reject) => {
    chrome.downloads.search(query, (items) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(items || []);
    });
  });
}

function cancelChromeDownload(downloadId) {
  if (!downloadId || !chrome.downloads?.cancel) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    chrome.downloads.cancel(downloadId, () => resolve());
  });
}

function eraseChromeDownload(downloadId) {
  if (!downloadId || !chrome.downloads?.erase) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    chrome.downloads.erase({ id: downloadId }, () => resolve());
  });
}

async function cleanupChromeDownloadHistory(watch, item = null, { cancel = false } = {}) {
  const downloadId = item?.id || watch?.downloadId || null;
  if (!downloadId) {
    return;
  }

  try {
    if (cancel) {
      await cancelChromeDownload(downloadId);
    }
  } catch {
    // History cleanup should never mask the real capture result.
  }

  try {
    await eraseChromeDownload(downloadId);
  } catch {
    // History cleanup should never mask the real capture result.
  }
}

async function completeDownloadWatchIfAlreadyFinished(watch, downloadId) {
  if (!downloadId || watch.done) {
    return false;
  }

  const items = await searchChromeDownload({ id: downloadId });
  const item = items?.[0];
  if (!item || watch.done) {
    return false;
  }
  if (item.state === "interrupted") {
    return fallbackOrFailWatch(watch, "Chrome download was interrupted");
  }
  if (item.state === "complete") {
    await completeDownloadWatch(watch, item);
    return true;
  }
  return false;
}

function executeScriptInTab(tabId, func, args = []) {
  return new Promise((resolve, reject) => {
    if (!chrome.scripting?.executeScript) {
      reject(new Error("Chrome scripting permission is unavailable"));
      return;
    }
    chrome.scripting.executeScript(
      {
        target: { tabId },
        world: "MAIN",
        func,
        args
      },
      (results) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(results?.[0]?.result || null);
      }
    );
  });
}

async function completePageContextUrlWatch(watch, url) {
  if (!watch?.tabId || watch.done || !url || !isChatGptContentUrl(url)) {
    return false;
  }

  const pageResult = await executeScriptInTab(
    watch.tabId,
    async (requestUrl) => {
      const response = await fetch(requestUrl, { credentials: "include" });
      if (!response.ok) {
        return { ok: false, error: `GPT page download failed with status ${response.status}` };
      }
      const buffer = await response.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buffer);
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
      }
      return {
        ok: true,
        url: response.url || requestUrl,
        contentType: response.headers.get("content-type") || "application/octet-stream",
        contentDisposition: response.headers.get("content-disposition") || "",
        base64Data: btoa(binary)
      };
    },
    [url]
  );

  if (!pageResult?.ok || !pageResult.base64Data) {
    throw new Error(pageResult?.error || "GPT page download did not return file data");
  }

  const imported = await importFetchedItem(watch, {
    filename:
      filenameFromContentDisposition(pageResult.contentDisposition || "") ||
      filenameFromUrl(pageResult.url || url) ||
      watch.expectedFilename ||
      "gpt-artifact",
    mime: pageResult.contentType || watch.contentType || "application/octet-stream",
    url: pageResult.url || url,
    base64Data: pageResult.base64Data
  });

  finishWatch(watch, {
    ok: true,
    artifact: imported.artifact,
    download: {
      id: null,
      filename: imported.artifact?.filename || watch.expectedFilename || null,
      url: pageResult.url || url
    }
  });
  return true;
}

function preferDirectUrlError(error) {
  return /Chrome scripting permission is unavailable/i.test(String(error?.message || error || ""));
}

async function fallbackOrFailWatch(watch, error) {
  if (watch?.done) {
    return true;
  }

  try {
    if (await completePageContextUrlWatch(watch, watch?.url || watch?.contentUrl || null)) {
      return true;
    }
  } catch {
    // Fall through to the original browser-download error; it is more useful to users.
  }

  await cleanupChromeDownloadHistory(watch, null, { cancel: true });
  failWatch(watch, error);
  return true;
}

async function completeDownloadWatchFromRecentSearch(watch) {
  if (!watch || watch.done || !watch.expectedFilename || !chrome.downloads) {
    return false;
  }

  const query = {
    query: [watch.expectedFilename],
    limit: 20,
    orderBy: ["-startTime"],
    startedAfter: new Date(Math.max(0, (watch.createdAt || Date.now()) - 30000)).toISOString()
  };
  const items = await searchChromeDownload(query);
  const match = [...(items || [])]
    .filter((item) => item?.state === "complete")
    .filter((item) => matchesExpectedFilename(item, watch.expectedFilename))
    .sort((a, b) => String(b.endTime || b.startTime || "").localeCompare(String(a.endTime || a.startTime || "")))[0];

  if (!match || watch.done) {
    return false;
  }

  watch.downloadId = match.id || watch.downloadId;
  await completeDownloadWatch(watch, match);
  return true;
}

async function downloadUrl(sender, input = {}) {
  if (!chrome.downloads) {
    throw new Error("Chrome downloads permission is unavailable");
  }
  if (!input.url) {
    throw new Error("downloadUrl needs a URL");
  }

  const filename = basename(input.filename || filenameFromUrl(input.url) || "");
  const started = startDownloadWatch({
    ...input,
    expectedFilename: filename || input.expectedFilename || null,
    tabId: sender?.tab?.id || null,
    url: input.url,
    contentType: input.contentType || null
  });
  const watch = watches.get(started.watchId);

  try {
    await completeDirectUrlWatch(watch, input.url, {
      filename: filename || input.expectedFilename || null,
      contentType: input.contentType || null
    });
    return waitForWatch(watch);
  } catch (directError) {
    let pageError = null;
    try {
      if (await completePageContextUrlWatch(watch, input.url)) {
        return waitForWatch(watch);
      }
    } catch (error) {
      pageError = error;
    }

    if (input.quietOnly || isChatGptContentUrl(input.url)) {
      failWatch(watch, pageError && !preferDirectUrlError(pageError) ? pageError : directError);
      return waitForWatch(watch);
    }
  }

  try {
    const downloadOptions = {
      url: input.url,
      saveAs: false,
      conflictAction: "uniquify"
    };
    if (filename) {
      downloadOptions.filename = filename;
    }

    const downloadId = await chromeDownload(downloadOptions);
    if (!watch.downloadId) {
      watch.downloadId = downloadId;
    }
    await completeDownloadWatchIfAlreadyFinished(watch, downloadId);
  } catch (error) {
    await fallbackOrFailWatch(watch, error);
  }

  return waitForWatch(watch);
}

function debuggerCall(method, ...args) {
  return new Promise((resolve, reject) => {
    method(...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

async function trustedClick(sender, input = {}) {
  const tabId = sender?.tab?.id;
  if (!tabId) {
    throw new Error("No sender tab for trusted click");
  }
  if (!chrome.debugger) {
    throw new Error("Chrome debugger permission is unavailable");
  }

  const x = Number(input.x);
  const y = Number(input.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("Trusted click needs finite viewport coordinates");
  }

  const target = { tabId };
  let attached = false;
  try {
    if (chrome.tabs?.update) {
      await debuggerCall(chrome.tabs.update, tabId, { active: true });
    }
    await debuggerCall(chrome.debugger.attach, target, "1.3");
    attached = true;
    await debuggerCall(chrome.debugger.sendCommand, target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0
    });
    await debuggerCall(chrome.debugger.sendCommand, target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await debuggerCall(chrome.debugger.sendCommand, target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
    return { ok: true };
  } finally {
    if (attached) {
      try {
        await debuggerCall(chrome.debugger.detach, target);
      } catch {
        // The click already happened; detach errors should not mask the download attempt.
      }
    }
  }
}

chrome.downloads?.onCreated.addListener((item) => {
  const watch = claimDownloadForWatch(item);
  if (watch && item.state === "complete") {
    completeDownloadWatch(watch, item);
  }
});

chrome.downloads?.onChanged.addListener((delta) => {
  const watch = [...watches.values()].find((candidate) => candidate.downloadId === delta.id && !candidate.done);
  if (!watch || !delta.state) {
    return;
  }

  if (delta.state.current === "interrupted") {
    fallbackOrFailWatch(watch, "Chrome download was interrupted");
    return;
  }

  if (delta.state.current !== "complete") {
    return;
  }

  chrome.downloads.search({ id: delta.id }, (items) => {
    const item = items?.[0];
    if (!item) {
      failWatch(watch, "Completed Chrome download could not be found");
      return;
    }
    completeDownloadWatch(watch, item);
  });
});

chrome.tabs?.onUpdated.addListener((tabId, changeInfo) => {
  const url = changeInfo?.url;
  if (!url) {
    return;
  }

  const watch = claimContentUrlForWatch(tabId, url);
  if (watch) {
    completeContentUrlWatch(watch, url);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "bridge:startDownloadWatch") {
    try {
      sendResponse(startDownloadWatch({ ...message, tabId: sender?.tab?.id || null }));
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  }

  if (message?.type === "bridge:awaitDownloadWatch") {
    awaitDownloadWatch(message.watchId, sendResponse);
    return true;
  }

  if (message?.type === "bridge:downloadUrl") {
    downloadUrl(sender, message).then(
      (result) => sendResponse(result),
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  if (message?.type === "bridge:trustedClick") {
    trustedClick(sender, message).then(
      (result) => sendResponse(result),
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  if (message?.type === "bridge:reloadExtension") {
    sendResponse({ ok: true });
    chrome.runtime.reload();
    return false;
  }

  return false;
});

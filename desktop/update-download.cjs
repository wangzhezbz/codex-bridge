"use strict";

const fs = require("node:fs");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { runWithNetworkDeadline } = require("../shared/network-deadline.cjs");
const MAX_UPDATE_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_UPDATE_DOWNLOAD_TIMEOUT_MS = 24 * 60 * 60_000;

async function downloadUpdateFile(url, targetPath, {
  expectedBytes = 0,
  fetchInitForDownload,
  fetchImpl = globalThis.fetch,
  maxBytes = 1024 * 1024 * 1024,
  onProgress,
  timeoutMs = 30 * 60_000,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw updateDownloadError("update_download_fetch_unavailable", "更新包下载失败：当前运行环境没有 fetch。");
  }
  const expected = positiveInteger(expectedBytes, 0);
  const configuredCeiling = Math.min(
    positiveInteger(maxBytes, MAX_UPDATE_DOWNLOAD_BYTES),
    MAX_UPDATE_DOWNLOAD_BYTES,
  );
  if (expected > MAX_UPDATE_DOWNLOAD_BYTES) {
    throw updateDownloadError(
      "update_download_too_large",
      `更新包大小异常：声明 ${expected} bytes，硬上限 ${MAX_UPDATE_DOWNLOAD_BYTES} bytes。`,
    );
  }
  const ceiling = expected || configuredCeiling;
  const deadlineMs = Math.min(
    positiveInteger(timeoutMs, 30 * 60_000),
    MAX_UPDATE_DOWNLOAD_TIMEOUT_MS,
  );
  let targetIdentity = null;
  let output = null;
  let outputClosed = null;

  try {
    return await runWithNetworkDeadline(async (signal) => {
      const baseInit = {
        headers: {
          "user-agent": "CodexBridge",
        },
        ...(signal ? { signal } : {}),
      };
      const preparedInit = typeof fetchInitForDownload === "function"
        ? fetchInitForDownload(url, baseInit)
        : baseInit;
      const response = await fetchImpl(url, {
        ...(preparedInit || {}),
        ...(signal ? { signal } : {}),
      });
      if (signal?.aborted) {
        bestEffortCancel(response?.body);
        throw signal.reason;
      }
      if (!response?.ok) {
        bestEffortCancel(response?.body);
        throw updateDownloadError("update_download_http_error", `更新包下载失败：HTTP ${response?.status || 0}`);
      }
      if (!response.body) {
        throw updateDownloadError("update_download_empty", "更新包下载失败：响应体为空。");
      }
      const contentLength = Number(response.headers?.get?.("content-length") || 0);
      if (Number.isFinite(contentLength) && contentLength > ceiling) {
        bestEffortCancel(response.body);
        throw updateDownloadError(
          "update_download_too_large",
          `更新包大小异常：声明 ${contentLength} bytes，当前上限 ${ceiling} bytes。`,
        );
      }
      const totalBytes = Number.isFinite(contentLength) && contentLength > 0
        ? contentLength
        : expected;
      let downloadedBytes = 0;
      const startedAt = Date.now();
      let lastEmitAt = 0;
      let lastPercent = -1;
      const emit = (force = false) => {
        if (typeof onProgress !== "function") {
          return;
        }
        const percent = totalBytes > 0
          ? Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100))
          : 0;
        const now = Date.now();
        if (!force && now - lastEmitAt < 200 && percent === lastPercent) {
          return;
        }
        lastEmitAt = now;
        lastPercent = percent;
        const elapsedSeconds = Math.max(0.001, (now - startedAt) / 1000);
        reportUpdateProgress(onProgress, {
          phase: "downloading",
          downloadedBytes,
          totalBytes,
          percent,
          bytesPerSecond: Math.floor(downloadedBytes / elapsedSeconds),
        });
      };
      emit(true);
      const progressStream = new Transform({
        transform(chunk, _encoding, callback) {
          downloadedBytes += chunk.length;
          if (downloadedBytes > ceiling) {
            callback(updateDownloadError(
              "update_download_too_large",
              `更新包大小异常：已接收 ${downloadedBytes} bytes，当前上限 ${ceiling} bytes。`,
            ));
            return;
          }
          emit(false);
          callback(null, chunk);
        },
        flush(callback) {
          emit(true);
          callback();
        },
      });
      let input;
      try {
        input = Readable.fromWeb(response.body);
      } catch (error) {
        bestEffortCancel(response.body);
        throw error;
      }
      let outputFd = null;
      let setupError = null;
      try {
        outputFd = fs.openSync(targetPath, "wx", 0o600);
        targetIdentity = fs.fstatSync(outputFd, { bigint: true });
        output = fs.createWriteStream(targetPath, { fd: outputFd, autoClose: true });
        outputClosed = new Promise((resolve) => output.once("close", resolve));
        outputFd = null;
        await pipeline(
          input,
          progressStream,
          output,
          ...(signal ? [{ signal }] : []),
        );
      } catch (error) {
        setupError = error;
        // fromWeb owns the reader lock, so cancel through that adapter even if
        // output initialization failed before pipeline installed its handlers.
        input.on("error", () => {});
        input.destroy();
        progressStream.destroy();
        throw error;
      } finally {
        if (outputFd !== null) {
          try {
            fs.closeSync(outputFd);
          } catch (closeError) {
            if (setupError) {
              throw new AggregateError(
                [setupError, closeError],
                setupError?.message || "更新包下载初始化失败且文件句柄关闭失败。",
                { cause: setupError },
              );
            }
            throw closeError;
          }
        }
      }
      emit(true);
      const finalStat = fs.lstatSync(targetPath, { bigint: true });
      if (!finalStat.isFile() || finalStat.isSymbolicLink()
        || finalStat.dev !== targetIdentity.dev || finalStat.ino !== targetIdentity.ino) {
        throw updateDownloadError(
          "update_download_target_changed",
          "更新包下载失败：目标文件已被替换。",
        );
      }
      const finalBytes = Number(finalStat.size);
      if (finalBytes === 0) {
        throw updateDownloadError("update_download_empty", "更新包下载失败：响应体为空。");
      }
      if (expected > 0 && finalBytes !== expected) {
        throw updateDownloadError(
          "update_download_incomplete",
          `更新包下载不完整：expected ${expected} bytes, got ${finalBytes} bytes`,
        );
      }
      return Object.freeze({ bytes: finalBytes, targetPath });
    }, {
      timeoutMs: deadlineMs,
      createTimeoutError: () => updateDownloadError(
        "update_download_timeout",
        `更新包下载超过 ${Math.ceil(deadlineMs / 60_000)} 分钟，已停止等待。`,
      ),
    });
  } catch (error) {
    if (targetIdentity) {
      try {
        if (output) {
          output.destroy();
          // The deadline can win before pipeline settles. Do not unlink or
          // report cleanup complete until the owned file handle has closed.
          await outputClosed;
        }
        removeExactPartialFile(targetPath, targetIdentity);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          error?.message || "更新包下载失败且半包清理失败。",
          { cause: error },
        );
      }
    }
    throw error;
  }
}

function updateDownloadError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function bestEffortCancel(body) {
  try {
    const result = body?.cancel?.();
    result?.catch?.(() => {});
  } catch {
    // The size error remains authoritative.
  }
}

function reportUpdateProgress(onProgress, event) {
  try {
    const pending = onProgress(event);
    Promise.resolve(pending).catch(() => {});
  } catch {
    // Progress reporting must never invalidate verified update bytes.
  }
}

function removeExactPartialFile(targetPath, identity) {
  try {
    const stat = fs.lstatSync(targetPath, { bigint: true });
    if (stat.isFile() && !stat.isSymbolicLink()
      && stat.dev === identity.dev && stat.ino === identity.ino) {
      fs.unlinkSync(targetPath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

module.exports = {
  downloadUpdateFile,
};

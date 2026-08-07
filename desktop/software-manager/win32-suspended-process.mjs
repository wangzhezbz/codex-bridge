import { createRequire } from "node:module";

const CREATE_SUSPENDED = 0x00000004;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const CREATE_NO_WINDOW = 0x08000000;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const WAIT_FAILED = 0xffff_ffff;
const STILL_ACTIVE = 259;
const TERMINATED_EXIT_CODE = 0xc000_013a;
const MAX_COMMAND_LINE_CHARS = 32_767;
const MAX_ENVIRONMENT_BYTES = 16 * 1024 * 1024;

function processError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function requireAbsolute(value, code) {
  if (typeof value !== "string" || !/^[A-Za-z]:\\/u.test(value) || value.includes("\0") || value.includes("/")) {
    throw processError(code);
  }
  return value;
}

export function quoteWindowsArgument(value) {
  if (typeof value !== "string" || value.includes("\0")) throw processError("windows_process_argument_invalid");
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1);
      result += '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes);
    backslashes = 0;
    result += character;
  }
  result += "\\".repeat(backslashes * 2);
  return `${result}"`;
}

function commandLine(executablePath, args) {
  if (!Array.isArray(args)) throw processError("windows_process_arguments_invalid");
  const value = [quoteWindowsArgument(executablePath), ...args.map(quoteWindowsArgument)].join(" ");
  if (value.length >= MAX_COMMAND_LINE_CHARS) throw processError("windows_process_command_line_too_long");
  return Buffer.from(`${value}\0`, "utf16le");
}

function environmentBlock(env, compareKeys) {
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    throw processError("windows_process_environment_invalid");
  }
  const rows = [];
  for (const [key, rawValue] of Object.entries(env)) {
    if (key.length === 0 || key.includes("=") || key.includes("\0") || rawValue === undefined) {
      throw processError("windows_process_environment_invalid");
    }
    const value = String(rawValue);
    if (value.includes("\0")) throw processError("windows_process_environment_invalid");
    rows.push([key, `${key}=${value}`]);
  }
  rows.sort(([left], [right]) => compareKeys(left, right));
  for (let index = 1; index < rows.length; index += 1) {
    if (compareKeys(rows[index - 1][0], rows[index][0]) === 0) {
      throw processError("windows_process_environment_duplicate");
    }
  }
  const encoded = Buffer.from(`${rows.map(([, row]) => row).join("\0")}\0\0`, "utf16le");
  if (encoded.length > MAX_ENVIRONMENT_BYTES) throw processError("windows_process_environment_too_large");
  return encoded;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readHandle(buffer, offset, pointerSize) {
  return pointerSize === 8 ? buffer.readBigUInt64LE(offset) : buffer.readUInt32LE(offset);
}

export function createWin32SuspendedProcessCapability({
  platform = process.platform,
  koffi,
  pollIntervalMs = 25,
  terminationWaitTimeoutMs = 10_000,
} = {}) {
  if (platform !== "win32") throw processError("windows_platform_required");
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1_000) {
    throw processError("windows_process_poll_interval_invalid");
  }
  if (!Number.isSafeInteger(terminationWaitTimeoutMs)
    || terminationWaitTimeoutMs < 1 || terminationWaitTimeoutMs > 30_000) {
    throw processError("windows_process_termination_timeout_invalid");
  }
  const ffi = koffi ?? createRequire(import.meta.url)("koffi");
  if (!ffi || typeof ffi.load !== "function") throw processError("koffi_adapter_required");
  const kernel32 = ffi.load("Kernel32.dll");
  const CreateProcessW = kernel32.func("__stdcall", "CreateProcessW", "int", [
    "str16", "void *", "void *", "void *", "int", "uint32_t", "void *", "str16", "void *", "void *",
  ]);
  const ResumeThread = kernel32.func("__stdcall", "ResumeThread", "uint32_t", ["intptr_t"]);
  const WaitForSingleObject = kernel32.func("__stdcall", "WaitForSingleObject", "uint32_t", ["intptr_t", "uint32_t"]);
  const TerminateProcess = kernel32.func("__stdcall", "TerminateProcess", "int", ["intptr_t", "uint32_t"]);
  const GetExitCodeProcess = kernel32.func("__stdcall", "GetExitCodeProcess", "int", ["intptr_t", "void *"]);
  const CompareStringOrdinal = kernel32.func("__stdcall", "CompareStringOrdinal", "int", [
    "str16", "int", "str16", "int", "int",
  ]);
  const CloseHandle = kernel32.func("__stdcall", "CloseHandle", "int", ["intptr_t"]);
  const GetLastError = kernel32.func("__stdcall", "GetLastError", "uint32_t", []);
  const pointerSize = typeof ffi.sizeof === "function" ? ffi.sizeof("intptr_t") : 8;
  if (pointerSize !== 4 && pointerSize !== 8) throw processError("windows_pointer_size_unsupported");
  const startupSize = pointerSize === 8 ? 104 : 68;
  const processInfoSize = pointerSize === 8 ? 24 : 16;
  let activeProcesses = 0;

  function nativeFailure(operation) {
    const error = processError("windows_process_native_call_failed");
    error.operation = operation;
    error.nativeCode = Number(GetLastError());
    return error;
  }

  function requireSuccess(value, operation) {
    if (!value) throw nativeFailure(operation);
  }

  function compareEnvironmentKeys(left, right) {
    const result = Number(CompareStringOrdinal(left, left.length, right, right.length, 1));
    if (result === 0) throw nativeFailure("CompareStringOrdinal");
    if (![1, 2, 3].includes(result)) throw processError("windows_process_compare_result_invalid");
    return result - 2;
  }

  async function waitUntilExit(processHandle, {
    timeoutMs, signal, observeSignal = true, timeoutCode = "windows_process_timeout",
  } = {}) {
    const startedAt = Date.now();
    for (;;) {
      const status = Number(WaitForSingleObject(processHandle, 0)) >>> 0;
      if (status === WAIT_OBJECT_0) break;
      if (status === WAIT_FAILED) throw nativeFailure("WaitForSingleObject");
      if (status !== WAIT_TIMEOUT) throw processError("windows_process_wait_result_invalid");
      if (observeSignal && signal?.aborted) throw processError("windows_process_aborted", signal.reason);
      if (Date.now() - startedAt >= timeoutMs) throw processError(timeoutCode);
      await delay(pollIntervalMs);
    }
    const output = Buffer.alloc(4);
    requireSuccess(GetExitCodeProcess(processHandle, output), "GetExitCodeProcess");
    const exitCode = output.readUInt32LE(0);
    if (exitCode === STILL_ACTIVE) throw processError("windows_process_exit_code_invalid");
    return exitCode;
  }

  async function closeHandles(processHandle, threadHandle, primaryError = null) {
    const errors = [];
    for (const handle of [threadHandle, processHandle]) {
      if (handle === null) continue;
      try { requireSuccess(CloseHandle(handle), "CloseHandle"); } catch (error) { errors.push(error); }
    }
    if (primaryError && errors.length > 0) {
      throw new AggregateError([primaryError, ...errors], primaryError.message, { cause: primaryError });
    }
    if (primaryError) throw primaryError;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "windows_process_handle_close_failed");
  }

  async function awaitResumeGate(beforeResume, pid, { timeoutMs, signal }) {
    let timeout = null;
    let onAbort = null;
    const gate = Promise.resolve().then(() => beforeResume(Object.freeze({ pid })));
    const cancellation = new Promise((_, reject) => {
      const finish = (error) => {
        if (timeout !== null) clearTimeout(timeout);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        reject(error);
      };
      onAbort = () => finish(processError("windows_process_aborted", signal.reason));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => finish(processError("windows_process_timeout")), timeoutMs);
    });
    try {
      await Promise.race([gate, cancellation]);
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  return Object.freeze({
    activeProcessCount() { return activeProcesses; },
    async run({ executablePath, args, cwd, env, timeoutMs, signal, beforeResume } = {}) {
      const executable = requireAbsolute(executablePath, "windows_process_executable_invalid");
      const workingDirectory = requireAbsolute(cwd, "windows_process_cwd_invalid");
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000) {
        throw processError("windows_process_timeout_invalid");
      }
      if (signal !== undefined && (typeof signal !== "object" || typeof signal.aborted !== "boolean"
        || typeof signal.addEventListener !== "function")) throw processError("windows_process_signal_invalid");
      if (typeof beforeResume !== "function") throw processError("windows_process_resume_gate_required");
      if (signal?.aborted) throw processError("windows_process_aborted", signal.reason);
      const command = commandLine(executable, args);
      const environment = environmentBlock(env, compareEnvironmentKeys);
      const deadline = Date.now() + timeoutMs;
      const startup = Buffer.alloc(startupSize);
      startup.writeUInt32LE(startupSize, 0);
      const info = Buffer.alloc(processInfoSize);
      let processHandle = null;
      let threadHandle = null;
      let exited = false;
      let primaryError = null;
      try {
        requireSuccess(CreateProcessW(
          executable, command, null, null, 0,
          CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
          environment, workingDirectory, startup, info,
        ), "CreateProcessW");
        processHandle = readHandle(info, 0, pointerSize);
        threadHandle = readHandle(info, pointerSize, pointerSize);
        const pidOffset = pointerSize * 2;
        const pid = info.readUInt32LE(pidOffset);
        if ((typeof processHandle === "bigint" ? processHandle === 0n : processHandle === 0)
          || (typeof threadHandle === "bigint" ? threadHandle === 0n : threadHandle === 0) || pid === 0) {
          throw processError("windows_process_information_invalid");
        }
        activeProcesses += 1;
        await awaitResumeGate(beforeResume, pid, { timeoutMs: Math.max(1, deadline - Date.now()), signal });
        if (signal?.aborted) throw processError("windows_process_aborted", signal.reason);
        if ((Number(ResumeThread(threadHandle)) >>> 0) === WAIT_FAILED) throw nativeFailure("ResumeThread");
        const exitCode = await waitUntilExit(processHandle, {
          timeoutMs: Math.max(1, deadline - Date.now()), signal,
        });
        exited = true;
        if (exitCode !== 0) {
          const error = processError("windows_process_exit_nonzero");
          error.exitCode = exitCode;
          throw error;
        }
        return Object.freeze({ pid, exitCode });
      } catch (error) {
        primaryError = error;
        if (error?.processExited === true) exited = true;
        if (processHandle !== null && !exited) {
          try {
            requireSuccess(TerminateProcess(processHandle, TERMINATED_EXIT_CODE), "TerminateProcess");
            await waitUntilExit(processHandle, {
              timeoutMs: terminationWaitTimeoutMs, observeSignal: false,
              timeoutCode: "windows_process_termination_wait_timeout",
            });
            exited = true;
          } catch (terminateError) {
            primaryError = new AggregateError([error, terminateError], error.message, { cause: error });
          }
        }
      } finally {
        if (processHandle !== null) activeProcesses -= 1;
        await closeHandles(processHandle, threadHandle, primaryError);
      }
      throw primaryError;
    },
  });
}

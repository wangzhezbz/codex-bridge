import path from "node:path";

const REGISTRY_KEYS = Object.freeze([
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1",
]);
const REGISTRY_FIELDS = Object.freeze([
  "DisplayName",
  "DisplayVersion",
  "InstallLocation",
  "UninstallString",
]);
const AUTHENTICODE_COMMAND = "$s=Get-AuthenticodeSignature -LiteralPath $env:CB_SM_PACKAGE_PATH; @{Status=[string]$s.Status; Thumbprint=$s.SignerCertificate.Thumbprint; Subject=$s.SignerCertificate.Subject}|ConvertTo-Json -Compress";
const PROCESS_LIST_COMMAND = "@(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress";
const POWERSHELL_ARGS = Object.freeze([
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
]);
const GIT_INSTALLER_ARGS = Object.freeze([
  "/VERYSILENT",
  "/NORESTART",
  "/NOCANCEL",
  "/SP-",
  "/CLOSEAPPLICATIONS",
  "/o:PathOption=Cmd",
]);
const GIT_UNINSTALLER_ARGS = Object.freeze([
  "/VERYSILENT",
  "/NORESTART",
  "/NOCANCEL",
]);
const SHORTCUT_NAMES = new Set(["ChatGPT", "V2RayN"]);
const MAX_SHORTCUT_COLLISIONS = 1_000;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1_024 * 1_024;

function hostError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireDriveAbsolute(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw hostError(code);
  const slashNormalized = value.replaceAll("/", "\\");
  if (!/^[a-z]:\\/iu.test(slashNormalized) || !path.win32.isAbsolute(slashNormalized)) throw hostError(code);
  const rawSegments = slashNormalized.slice(3).split("\\");
  if (rawSegments.some((segment) => segment === "." || segment === "..")) throw hostError(code);
  if (/[<>:"|?*\u0000-\u001f]/u.test(slashNormalized.slice(2))) throw hostError(code);
  const normalized = path.win32.normalize(slashNormalized);
  const segments = normalized.slice(3).split("\\").filter(Boolean);
  if (segments.some((segment) => /[ .]$/u.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))) {
    throw hostError(code);
  }
  return normalized;
}

function requireExecutablePath(value) {
  const normalized = requireDriveAbsolute(value, "executable_path_absolute_required");
  if (path.win32.extname(normalized).toLowerCase() !== ".exe") {
    throw hostError("executable_path_rejected");
  }
  return normalized;
}

function requireDirectoryPath(value, code) {
  const normalized = requireDriveAbsolute(value, code);
  if (path.win32.dirname(normalized).toLowerCase() === normalized.toLowerCase()) {
    throw hostError(`${code}_root_rejected`);
  }
  return normalized;
}

function pathKey(value) {
  return path.win32.normalize(value).toLowerCase();
}

function childEnvironment(env, extra = {}) {
  return { ...env, ...extra };
}

function commandOptions(env, overrides = {}) {
  return {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    env: childEnvironment(env),
    ...overrides,
  };
}

function exitCode(result) {
  if (!isPlainRecord(result)) throw hostError("host_command_result_invalid");
  const code = result.exitCode ?? result.code ?? 0;
  if (!Number.isInteger(code)) throw hostError("host_command_result_invalid");
  return code;
}

function outputText(result, field) {
  const value = result[field] ?? "";
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  throw hostError("host_command_result_invalid");
}

async function runCommand(execFile, env, file, args, {
  allowedExitCodes = [0],
  options = {},
  errorCode = "host_command_failed",
} = {}) {
  let result;
  try {
    result = await execFile(file, [...args], commandOptions(env, options));
  } catch (error) {
    const thrownExitCode = Number.isInteger(error?.exitCode)
      ? error.exitCode
      : (Number.isInteger(error?.code) ? error.code : null);
    if (thrownExitCode === null || !allowedExitCodes.includes(thrownExitCode)) {
      throw hostError(errorCode, error);
    }
    result = {
      exitCode: thrownExitCode,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
  const code = exitCode(result);
  if (!allowedExitCodes.includes(code)) throw hostError(errorCode);
  return {
    exitCode: code,
    stdout: outputText(result, "stdout"),
    stderr: outputText(result, "stderr"),
  };
}

function gitExecutionPlan(plan) {
  const timeoutMs = plan.timeoutMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 30 * 60_000) {
    throw hostError("git_execution_timeout_invalid");
  }
  if (plan.signal !== undefined && (typeof plan.signal !== "object"
    || typeof plan.signal.addEventListener !== "function" || typeof plan.signal.aborted !== "boolean")) {
    throw hostError("git_execution_signal_invalid");
  }
  if (typeof plan.onStarted !== "function") throw hostError("git_process_start_callback_required");
  return { timeoutMs, signal: plan.signal, beforeResume: plan.onStarted };
}

function parseRegistryOutput(stdout) {
  const record = {};
  const allowed = new Set(REGISTRY_FIELDS);
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\s+([^\s]+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/iu.exec(line);
    if (!match || !allowed.has(match[1])) continue;
    if (Object.hasOwn(record, match[1])) throw hostError("git_registry_incomplete");
    record[match[1]] = match[2].trim();
  }
  return Object.keys(record).length === 0 ? null : record;
}

async function readRegistryWithReg(execFile, env, key) {
  const result = await runCommand(execFile, env, "reg.exe", ["query", key], {
    allowedExitCodes: [0, 1],
    errorCode: "git_registry_query_failed",
  });
  if (result.exitCode === 1) return null;
  return parseRegistryOutput(result.stdout);
}

function validateRegistryRecord(value, registryKey) {
  if (!isPlainRecord(value)) throw hostError("git_registry_incomplete");
  const keys = Object.keys(value);
  if (keys.some((key) => !REGISTRY_FIELDS.includes(key))) throw hostError("git_registry_fields_rejected");
  if (keys.length !== REGISTRY_FIELDS.length || REGISTRY_FIELDS.some((key) => !Object.hasOwn(value, key))) {
    throw hostError("git_registry_incomplete");
  }
  if (value.DisplayName !== "Git" || typeof value.DisplayVersion !== "string"
    || value.DisplayVersion.length === 0 || value.DisplayVersion.length > 128) {
    throw hostError("git_registry_incomplete");
  }

  let installDir;
  let uninstallerPath;
  try {
    installDir = requireDirectoryPath(value.InstallLocation, "git_install_location_absolute_required");
    const uninstallValue = strictUninstallExecutable(value.UninstallString);
    uninstallerPath = requireExecutablePath(uninstallValue);
  } catch (error) {
    throw hostError("git_registry_incomplete", error);
  }
  if (pathKey(path.win32.dirname(uninstallerPath)) !== pathKey(installDir)
    || !/^unins\d{3}\.exe$/iu.test(path.win32.basename(uninstallerPath))) {
    throw hostError("git_registry_incomplete");
  }

  return {
    registryKey,
    version: value.DisplayVersion,
    installDir,
    uninstallerPath,
    executablePath: path.win32.join(installDir, "cmd", "git.exe"),
  };
}

function strictUninstallExecutable(value) {
  if (typeof value !== "string" || value.length === 0) throw hostError("git_registry_incomplete");
  const trimmed = value.trim();
  if (!trimmed.startsWith("\"")) return trimmed;
  const match = /^"([^"]+)"$/u.exec(trimmed);
  if (!match) throw hostError("git_registry_incomplete");
  return match[1];
}

async function discoverWhereGit(execFile, env) {
  const result = await runCommand(execFile, env, "where.exe", ["git.exe"], {
    allowedExitCodes: [0, 1],
    errorCode: "git_path_query_failed",
  });
  if (result.exitCode === 1) return [];
  const paths = [];
  const seen = new Set();
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let executablePath;
    try {
      executablePath = requireExecutablePath(line.trim());
    } catch (error) {
      throw hostError("git_path_query_invalid", error);
    }
    if (path.win32.basename(executablePath).toLowerCase() !== "git.exe") {
      throw hostError("git_path_query_invalid");
    }
    const key = pathKey(executablePath);
    if (!seen.has(key)) {
      seen.add(key);
      paths.push(executablePath);
    }
  }
  return paths;
}

function parseAuthenticode(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw hostError("authenticode_output_invalid", error);
  }
  if (!isPlainRecord(parsed) || typeof parsed.Status !== "string" || parsed.Status.length === 0
    || !(typeof parsed.Thumbprint === "string" || parsed.Thumbprint === null)
    || !(typeof parsed.Subject === "string" || parsed.Subject === null)) {
    throw hostError("authenticode_output_invalid");
  }
  return {
    status: parsed.Status,
    thumbprint: parsed.Thumbprint,
    subject: parsed.Subject,
  };
}

function parseProcessList(stdout) {
  if (stdout.trim().length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw hostError("process_list_invalid", error);
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

function validateProcessRecords(value) {
  if (!Array.isArray(value)) throw hostError("process_list_invalid");
  return value.map((record) => {
    if (!isPlainRecord(record)) throw hostError("process_list_invalid");
    const pid = record.pid ?? record.ProcessId;
    const executablePath = record.executablePath ?? record.ExecutablePath ?? null;
    if (!Number.isSafeInteger(pid) || pid <= 0
      || !(executablePath === null || typeof executablePath === "string")) {
      throw hostError("process_list_invalid");
    }
    if (executablePath === null || executablePath.length === 0) return { pid, executablePath: null };
    try {
      return { pid, executablePath: requireExecutablePath(executablePath) };
    } catch (error) {
      throw hostError("process_list_invalid", error);
    }
  });
}

function requireElectronMethod(electronShell, name) {
  if (typeof electronShell?.[name] !== "function") throw hostError(`shortcut_${name}_required`);
  return electronShell[name].bind(electronShell);
}

function requireShortcutFileApi(shortcutFileApi) {
  const methods = ["createTemp", "sealTemp", "commitNoReplace", "removeTemp", "inspectExact", "removeExact", "release"];
  if (!isPlainRecord(shortcutFileApi)
    || methods.some((name) => typeof shortcutFileApi[name] !== "function")) {
    throw hostError("shortcut_file_capability_required");
  }
  return shortcutFileApi;
}

function validateShortcutTemp(temp, desktopPath) {
  if (!isPlainRecord(temp) || typeof temp.path !== "string") {
    throw hostError("shortcut_temp_capability_invalid");
  }
  const tempPath = requireDriveAbsolute(temp.path, "shortcut_temp_capability_invalid");
  const basename = path.win32.basename(tempPath);
  if (pathKey(path.win32.dirname(tempPath)) !== pathKey(desktopPath)
    || path.win32.extname(basename).toLowerCase() !== ".lnk"
    || /^(?:ChatGPT|V2RayN)(?:（[1-9]\d*）)?\.lnk$/u.test(basename)) {
    throw hostError("shortcut_temp_capability_invalid");
  }
  return { temp, tempPath };
}

async function cleanupShortcutTemp(shortcutFileApi, temp, primaryError) {
  try {
    await shortcutFileApi.removeTemp(temp);
  } catch (cleanupError) {
    const wrappedCleanup = hostError("shortcut_temp_cleanup_failed", cleanupError);
    if (primaryError) {
      throw new AggregateError([primaryError, wrappedCleanup], primaryError.message, { cause: primaryError });
    }
    throw wrappedCleanup;
  }
  if (primaryError) throw primaryError;
}

function validateShortcutInspection(value) {
  if (!isPlainRecord(value) || !["absent", "file", "other"].includes(value.kind)) {
    throw hostError("shortcut_file_inspection_invalid");
  }
  if (value.kind === "file" && typeof value.path !== "string") {
    throw hostError("shortcut_file_inspection_invalid");
  }
  return value;
}

async function awaitSpawnEvidence(handle) {
  if (handle === null || (typeof handle !== "object" && typeof handle !== "function")
    || !Number.isSafeInteger(handle.pid) || handle.pid <= 0 || typeof handle.unref !== "function") {
    throw hostError("spawn_detached_result_invalid");
  }
  const evidence = handle.started ?? handle.start;
  if (evidence === true) return handle;
  if (evidence === null || (typeof evidence !== "object" && typeof evidence !== "function")
    || typeof evidence.then !== "function") {
    throw hostError("spawn_detached_result_invalid");
  }
  await evidence;
  return handle;
}

async function readShortcut(electronShell, shortcutPath) {
  let details;
  try {
    details = await requireElectronMethod(electronShell, "readShortcutLink")(shortcutPath);
  } catch (error) {
    throw hostError("shortcut_read_failed", error);
  }
  if (!isPlainRecord(details) || typeof details.target !== "string") {
    throw hostError("shortcut_read_failed");
  }
  let target;
  try {
    target = requireExecutablePath(details.target);
  } catch (error) {
    throw hostError("shortcut_target_invalid", error);
  }
  return { target };
}

function shortcutFileName(name, collision) {
  return collision === 0 ? `${name}.lnk` : `${name}（${collision}）.lnk`;
}

function validateRecordedShortcut(record) {
  if (!isPlainRecord(record)) throw hostError("shortcut_record_invalid");
  const desktopPath = requireDirectoryPath(record.desktopPath, "shortcut_desktop_absolute_required");
  const shortcutPath = requireDriveAbsolute(record.path, "shortcut_path_absolute_required");
  const targetPath = requireExecutablePath(record.targetPath);
  if (pathKey(path.win32.dirname(shortcutPath)) !== pathKey(desktopPath)) {
    throw hostError("shortcut_path_not_desktop_child");
  }
  if (!/^(?:ChatGPT|V2RayN)(?:（[1-9]\d*）)?\.lnk$/u.test(path.win32.basename(shortcutPath))) {
    throw hostError("shortcut_path_rejected");
  }
  return { desktopPath, shortcutPath, targetPath };
}

export function createWindowsHost({
  platform,
  execFile,
  electronShell,
  registryReader,
  processLister,
  shortcutFileApi,
  spawnDetached,
  suspendedProcess,
  env = {},
} = {}) {
  if (platform !== "win32") throw hostError("windows_platform_required");
  if (typeof execFile !== "function") throw hostError("exec_file_adapter_required");
  if (!isPlainRecord(env)) throw hostError("environment_record_required");
  if (registryReader !== undefined && typeof registryReader !== "function") {
    throw hostError("registry_reader_invalid");
  }
  if (processLister !== undefined && typeof processLister !== "function") {
    throw hostError("process_lister_invalid");
  }

  const readRegistry = registryReader ?? (async ({ key }) => readRegistryWithReg(execFile, env, key));
  const listProcesses = processLister ?? (async () => {
    const result = await runCommand(execFile, env, "powershell.exe", [...POWERSHELL_ARGS, PROCESS_LIST_COMMAND], {
      errorCode: "process_list_failed",
    });
    return parseProcessList(result.stdout);
  });

  return Object.freeze({
    async discoverGit() {
      const records = [];
      for (const key of REGISTRY_KEYS) {
        let raw;
        try {
          raw = await readRegistry({ key, fields: [...REGISTRY_FIELDS] });
        } catch (error) {
          if (error?.code) throw error;
          throw hostError("git_registry_query_failed", error);
        }
        if (raw !== null && raw !== undefined) records.push(validateRegistryRecord(raw, key));
      }
      if (records.length > 1) throw hostError("git_multiple_installations");

      const pathExecutables = await discoverWhereGit(execFile, env);
      if (pathExecutables.length > 1) throw hostError("git_multiple_installations");
      if (records.length === 0 && pathExecutables.length === 0) return { kind: "none" };
      if (records.length === 0) throw hostError("git_portable_or_unregistered");
      if (pathExecutables.length === 0) throw hostError("git_registry_incomplete");

      const record = records[0];
      if (pathKey(record.executablePath) !== pathKey(pathExecutables[0])) {
        throw hostError("git_executable_mismatch");
      }
      return {
        kind: "external",
        ownership: "external",
        version: record.version,
        installDir: record.installDir,
        executablePath: record.executablePath,
        uninstallerPath: record.uninstallerPath,
        registryKey: record.registryKey,
      };
    },

    async verifyAuthenticode(filePath) {
      const packagePath = requireExecutablePath(filePath);
      const result = await runCommand(
        execFile,
        env,
        "powershell.exe",
        [...POWERSHELL_ARGS, AUTHENTICODE_COMMAND],
        {
          options: { env: childEnvironment(env, { CB_SM_PACKAGE_PATH: packagePath }) },
          errorCode: "authenticode_query_failed",
        },
      );
      return parseAuthenticode(result.stdout);
    },

    async stopOwnedProcesses(executablePaths) {
      if (!Array.isArray(executablePaths)) throw hostError("owned_executable_paths_required");
      const owned = new Set(executablePaths.map((value) => pathKey(requireExecutablePath(value))));
      const processes = validateProcessRecords(await listProcesses());
      const candidateProcessIds = [...new Set(processes
        .filter((process) => process.executablePath !== null && owned.has(pathKey(process.executablePath)))
        .map((process) => process.pid))]
        .sort((left, right) => left - right);
      const stoppedProcessIds = [];
      for (const processId of candidateProcessIds) {
        const currentProcesses = validateProcessRecords(await listProcesses());
        const current = currentProcesses.find((process) => process.pid === processId);
        if (current?.executablePath === null || !current?.executablePath
          || !owned.has(pathKey(current.executablePath))) {
          continue;
        }
        await runCommand(execFile, env, "taskkill.exe", ["/PID", String(processId), "/F"], {
          errorCode: "owned_process_stop_failed",
        });
        stoppedProcessIds.push(processId);
      }
      return { stoppedProcessIds };
    },

    async launchOwned(executablePath) {
      const target = requireExecutablePath(executablePath);
      if (typeof spawnDetached !== "function") throw hostError("spawn_detached_adapter_required");
      let handle;
      try {
        handle = await spawnDetached(target, [], {
          shell: false,
          stdio: "ignore",
          windowsHide: false,
          detached: true,
          env: childEnvironment(env),
        });
        await awaitSpawnEvidence(handle);
      } catch (error) {
        if (error?.code === "spawn_detached_result_invalid") throw error;
        throw hostError("owned_process_launch_failed", error);
      }
      try {
        handle.unref();
      } catch (error) {
        throw hostError("owned_process_launch_failed", error);
      }
      return { executablePath: target, pid: handle.pid };
    },

    async createShortcut(record) {
      if (!isPlainRecord(record)) throw hostError("shortcut_record_invalid");
      const desktopPath = requireDirectoryPath(record.desktopPath, "shortcut_desktop_absolute_required");
      if (!SHORTCUT_NAMES.has(record.name)) throw hostError("shortcut_name_rejected");
      const targetPath = requireExecutablePath(record.targetPath);
      const fileApi = requireShortcutFileApi(shortcutFileApi);
      let temp;
      try {
        temp = await fileApi.createTemp({ directory: desktopPath, suffix: ".lnk" });
      } catch (error) {
        throw hostError("shortcut_temp_create_failed", error);
      }
      let validatedTemp;
      try {
        validatedTemp = validateShortcutTemp(temp, desktopPath);
      } catch (error) {
        await cleanupShortcutTemp(fileApi, temp, error);
      }
      let committed = false;
      let activeTemp = temp;
      let primaryError = null;
      let result = null;
      try {
        const created = await requireElectronMethod(electronShell, "writeShortcutLink")(
          validatedTemp.tempPath,
          "create",
          { target: targetPath, cwd: path.win32.dirname(targetPath), description: record.name },
        );
        if (created !== true) throw hostError("shortcut_create_failed");
        let sealedTemp;
        try {
          sealedTemp = await fileApi.sealTemp(temp);
        } catch (error) {
          throw hostError("shortcut_temp_seal_failed", error);
        }
        if (!isPlainRecord(sealedTemp) || sealedTemp.path !== validatedTemp.tempPath) {
          throw hostError("shortcut_temp_capability_invalid");
        }
        activeTemp = sealedTemp;
        const current = await readShortcut(electronShell, activeTemp.path);
        if (pathKey(current.target) !== pathKey(targetPath)) throw hostError("shortcut_target_mismatch");

        for (let collision = 0; collision < MAX_SHORTCUT_COLLISIONS; collision += 1) {
          const candidate = path.win32.join(desktopPath, shortcutFileName(record.name, collision));
          let status;
          try {
            status = await fileApi.commitNoReplace(activeTemp, candidate);
          } catch (error) {
            throw hostError("shortcut_commit_failed", error);
          }
          if (status === "occupied") continue;
          if (status !== "committed") throw hostError("shortcut_commit_result_invalid");
          committed = true;
          result = { path: candidate, desktopPath, targetPath };
          break;
        }
        if (!committed) throw hostError("shortcut_collision_limit_exceeded");
      } catch (error) {
        primaryError = error;
      }
      if (!committed) await cleanupShortcutTemp(fileApi, activeTemp, primaryError);
      if (primaryError) throw primaryError;
      return result;
    },

    async removeRecordedShortcut(record) {
      const { shortcutPath, targetPath } = validateRecordedShortcut(record);
      const fileApi = requireShortcutFileApi(shortcutFileApi);
      const inspected = validateShortcutInspection(await fileApi.inspectExact(shortcutPath));
      if (inspected.kind === "absent") return { removed: false, path: shortcutPath };
      if (inspected.kind !== "file") throw hostError("shortcut_path_not_file");
      let removed = false;
      try {
        const current = await readShortcut(electronShell, inspected.path);
        if (pathKey(current.target) !== pathKey(targetPath)) throw hostError("shortcut_target_mismatch");
        removed = await fileApi.removeExact(inspected);
      } catch (error) {
        try {
          await fileApi.release(inspected);
        } catch (releaseError) {
          throw new AggregateError([error, releaseError], error.message, { cause: error });
        }
        throw error;
      }
      if (removed !== true) throw hostError("shortcut_remove_failed");
      const after = validateShortcutInspection(await fileApi.inspectExact(shortcutPath));
      if (after.kind !== "absent") {
        if (after.kind === "file") await fileApi.release(after);
        throw hostError("shortcut_remove_failed");
      }
      return { removed: true, path: shortcutPath };
    },

    async runGitInstaller(plan) {
      if (!isPlainRecord(plan)) throw hostError("git_installer_plan_invalid");
      const installerPath = requireExecutablePath(plan.installerPath);
      const targetDir = requireDirectoryPath(plan.targetDir, "git_target_absolute_required");
      if (typeof suspendedProcess?.run !== "function") throw hostError("git_suspended_process_capability_required");
      const execution = gitExecutionPlan(plan);
      try {
        await suspendedProcess.run({
          executablePath: installerPath,
          args: [...GIT_INSTALLER_ARGS, `/DIR=${targetDir}`],
          cwd: path.win32.dirname(installerPath),
          env: childEnvironment(env),
          ...execution,
        });
      } catch (error) { throw hostError("git_installer_failed", error); }
      return { targetDir };
    },

    async runGitUninstaller(plan) {
      if (!isPlainRecord(plan)) throw hostError("git_uninstaller_plan_invalid");
      const uninstallerPath = requireExecutablePath(plan.uninstallerPath);
      const installDir = requireDirectoryPath(plan.installDir, "git_install_location_absolute_required");
      if (pathKey(path.win32.dirname(uninstallerPath)) !== pathKey(installDir)
        || !/^unins\d{3}\.exe$/iu.test(path.win32.basename(uninstallerPath))) {
        throw hostError("git_uninstaller_path_mismatch");
      }
      if (typeof suspendedProcess?.run !== "function") throw hostError("git_suspended_process_capability_required");
      const execution = gitExecutionPlan(plan);
      try {
        await suspendedProcess.run({
          executablePath: uninstallerPath,
          args: [...GIT_UNINSTALLER_ARGS],
          cwd: installDir,
          env: childEnvironment(env),
          ...execution,
        });
      } catch (error) { throw hostError("git_uninstaller_failed", error); }
      return { installDir };
    },
  });
}

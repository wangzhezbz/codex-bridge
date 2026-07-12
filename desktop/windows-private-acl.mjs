import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const SID_PATTERN = /^S-\d(?:-\d+){2,15}$/iu;
const TRUSTED_SYSTEM_SIDS = Object.freeze([
  "S-1-5-18",
  "S-1-5-32-544",
]);
const PRIVATE_ACL_REPLACED_SENTINEL = "CODEXBRIDGE_PRIVATE_ACL_REPLACED";
const POWERSHELL_BINDING_KEYS = Object.freeze({
  kind: "CODEXBRIDGE_PRIVATE_ACL_KIND",
  literalPath: "CODEXBRIDGE_PRIVATE_ACL_LITERAL_PATH",
  userSid: "CODEXBRIDGE_PRIVATE_ACL_USER_SID",
});
const POWERSHELL_BINDING_KEY_SET = new Set(
  Object.values(POWERSHELL_BINDING_KEYS),
);
const POWERSHELL_REPLACE_DACL_SCRIPT = String.raw`& {
  $ErrorActionPreference = "Stop"
  [string] $LiteralPath = [Environment]::GetEnvironmentVariable("CODEXBRIDGE_PRIVATE_ACL_LITERAL_PATH", "Process")
  [string] $Kind = [Environment]::GetEnvironmentVariable("CODEXBRIDGE_PRIVATE_ACL_KIND", "Process")
  [string] $UserSid = [Environment]::GetEnvironmentVariable("CODEXBRIDGE_PRIVATE_ACL_USER_SID", "Process")
  if ([string]::IsNullOrEmpty($LiteralPath) -or $Kind -notin @("file", "directory") -or $UserSid -notmatch '^S-[0-9]+(?:-[0-9]+){2,15}$') {
    throw "invalid private ACL binding"
  }
  $item = Get-Item -LiteralPath $LiteralPath -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "reparse points are not allowed"
  }
  if (($Kind -eq "directory") -ne [bool] $item.PSIsContainer) {
    throw "private ACL path kind mismatch"
  }
  $security = Get-Acl -LiteralPath $LiteralPath
  $security.SetAccessRuleProtection($true, $false)
  foreach ($existingRule in @($security.Access)) {
    [void] $security.RemoveAccessRuleSpecific($existingRule)
  }
  if ($Kind -eq "directory") {
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $trusted = @($UserSid, "S-1-5-18", "S-1-5-32-544") | Select-Object -Unique
  foreach ($sidValue in $trusted) {
    $sid = [System.Security.Principal.SecurityIdentifier]::new($sidValue)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void] $security.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $LiteralPath -AclObject $security
  [Console]::Out.WriteLine("CODEXBRIDGE_PRIVATE_ACL_REPLACED")
}`;

function privateAclError(code) {
  const error = new Error("Windows private ACL operation failed");
  error.name = "WindowsPrivateAclError";
  error.code = code;
  return error;
}

function outputBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return Buffer.alloc(0);
  }
  return Buffer.from(String(value), "utf8");
}

function commandEnvironment(environment) {
  if (environment === undefined) {
    return undefined;
  }
  if (
    !environment ||
    typeof environment !== "object" ||
    Array.isArray(environment)
  ) {
    throw privateAclError("windows_private_acl_invalid_command");
  }
  const entries = Object.entries(environment);
  if (
    entries.length !== POWERSHELL_BINDING_KEY_SET.size ||
    entries.some(([key, value]) =>
      !POWERSHELL_BINDING_KEY_SET.has(key) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 32_767 ||
      value.includes("\0"))
  ) {
    throw privateAclError("windows_private_acl_invalid_command");
  }
  const bindingNames = new Set(
    [...POWERSHELL_BINDING_KEY_SET].map((key) => key.toUpperCase()),
  );
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !bindingNames.has(key.toUpperCase()),
    ),
  );
  return { ...inherited, ...environment };
}

export function runBoundedWindowsCommand(
  executable,
  args,
  {
    environment,
    execFileImpl = execFile,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  } = {},
) {
  if (typeof executable !== "string" || !path.win32.isAbsolute(executable)) {
    return Promise.reject(privateAclError("windows_private_acl_invalid_command"));
  }
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    return Promise.reject(privateAclError("windows_private_acl_invalid_command"));
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    return Promise.reject(privateAclError("windows_private_acl_invalid_timeout"));
  }

  return new Promise((resolve, reject) => {
    let child = null;
    let settled = false;
    let watchdog = null;
    let childEnvironment;
    try {
      childEnvironment = commandEnvironment(environment);
    } catch (error) {
      reject(error);
      return;
    }
    const options = {
      encoding: null,
      killSignal: "SIGKILL",
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      shell: false,
      timeout: timeoutMs,
      windowsHide: true,
    };
    if (childEnvironment) {
      options.env = childEnvironment;
    }
    const finish = (complete, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (watchdog) {
        clearTimeout(watchdog);
      }
      complete(value);
    };
    const onComplete = (error, stdout, stderr) => {
      if (error) {
        if (
          error.killed === true ||
          error.code === "ETIMEDOUT" ||
          error.signal === "SIGKILL"
        ) {
          finish(reject, privateAclError("windows_private_acl_timeout"));
          return;
        }
        // execFile reports every nonzero exit as an error. Treat launch errors,
        // output-limit errors, and nonzero exits identically without reflecting
        // command text, paths, identities, or localized stderr.
        finish(reject, privateAclError("windows_private_acl_command_failed"));
        return;
      }
      finish(resolve, {
        stderr: outputBuffer(stderr),
        stdout: outputBuffer(stdout),
      });
    };

    try {
      child = execFileImpl(executable, [...args], options, onComplete);
    } catch {
      finish(reject, privateAclError("windows_private_acl_command_failed"));
      return;
    }
    if (!settled) {
      watchdog = setTimeout(() => {
        try {
          child?.kill?.("SIGKILL");
        } catch {
          // The operation still fails closed even if the host cannot signal it.
        }
        finish(reject, privateAclError("windows_private_acl_timeout"));
      }, timeoutMs);
      watchdog.unref?.();
    }
  });
}

function normalizeWindowsRoot(systemRoot) {
  if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)) {
    throw privateAclError("windows_private_acl_invalid_system_root");
  }
  return path.win32.resolve(systemRoot);
}

function systemExecutable(systemRoot, fileName) {
  return path.win32.join(
    normalizeWindowsRoot(systemRoot),
    "System32",
    fileName,
  );
}

function sddlPrincipalsForSid(sid, { localAccount = false } = {}) {
  const wellKnown = new Map([
    ["S-1-5-18", "SY"],
    ["S-1-5-19", "LS"],
    ["S-1-5-20", "NS"],
    ["S-1-5-32-544", "BA"],
  ]);
  if (wellKnown.has(sid)) {
    return new Set([wellKnown.get(sid), sid.toUpperCase()]);
  }
  if (localAccount && /-500$/u.test(sid)) {
    return new Set(["LA", sid.toUpperCase()]);
  }
  if (localAccount && /-501$/u.test(sid)) {
    return new Set(["LG", sid.toUpperCase()]);
  }
  return new Set([sid.toUpperCase()]);
}

function aceFlagsAreExact(value, kind) {
  const tokens = value.match(/.{2}/gu) || [];
  if (tokens.join("") !== value) {
    return false;
  }
  const actual = new Set(tokens);
  const expected = kind === "directory"
    ? new Set(["OI", "CI"])
    : new Set();
  return (
    actual.size === expected.size &&
    [...actual].every((token) => expected.has(token))
  );
}

function extractDaclSection(sddl) {
  if (typeof sddl !== "string" || !sddl.startsWith("D:")) {
    throw privateAclError("windows_private_acl_verification_failed");
  }
  let depth = 0;
  for (let index = 2; index < sddl.length; index += 1) {
    if (sddl[index] === "(") {
      depth += 1;
      continue;
    }
    if (sddl[index] === ")") {
      depth -= 1;
      if (depth < 0) {
        throw privateAclError("windows_private_acl_verification_failed");
      }
      continue;
    }
    if (
      depth === 0 &&
      ["O", "G", "S"].includes(sddl[index]) &&
      sddl[index + 1] === ":"
    ) {
      return sddl.slice(0, index);
    }
  }
  if (depth !== 0) {
    throw privateAclError("windows_private_acl_verification_failed");
  }
  return sddl;
}

function validateSavedDacl(savedSddl, expectedPrincipalGroups, kind) {
  const sddl = extractDaclSection(savedSddl);
  const firstAce = sddl.indexOf("(");
  if (firstAce < 0) {
    throw privateAclError("windows_private_acl_verification_failed");
  }
  const daclFlags = sddl.slice(2, firstAce);
  if (!daclFlags.includes("P") || !/^(?:P|AI|AR)*$/u.test(daclFlags)) {
    throw privateAclError("windows_private_acl_verification_failed");
  }

  const aceMatches = [...sddl.slice(firstAce).matchAll(/\(([^()]*)\)/gu)];
  if (aceMatches.length !== expectedPrincipalGroups.length) {
    throw privateAclError("windows_private_acl_verification_failed");
  }
  if (aceMatches.map((match) => match[0]).join("") !== sddl.slice(firstAce)) {
    throw privateAclError("windows_private_acl_verification_failed");
  }

  const matchedGroups = new Set();
  for (const [, ace] of aceMatches) {
    const fields = ace.split(";");
    if (
      fields.length !== 6 ||
      fields[0] !== "A" ||
      !aceFlagsAreExact(fields[1], kind) ||
      fields[2] !== "FA" ||
      fields[3] !== "" ||
      fields[4] !== ""
    ) {
      throw privateAclError("windows_private_acl_verification_failed");
    }
    const principal = fields[5].toUpperCase();
    const groupIndex = expectedPrincipalGroups.findIndex(
      (group, index) => group.has(principal) && !matchedGroups.has(index),
    );
    if (groupIndex < 0) {
      throw privateAclError("windows_private_acl_verification_failed");
    }
    matchedGroups.add(groupIndex);
  }
}

function statsIdentity(stats) {
  return `${String(stats.dev)}:${String(stats.ino)}`;
}

function validatePathStats(stats, kind) {
  const isDirectory = stats?.isDirectory?.() === true;
  const isFile = stats?.isFile?.() === true;
  if (
    stats?.isSymbolicLink?.() ||
    (kind === "directory" ? !isDirectory : !isFile) ||
    (kind === "file" && Number.isInteger(stats.nlink) && stats.nlink !== 1)
  ) {
    throw privateAclError("windows_private_acl_invalid_path");
  }
}

export function createWindowsPrivateAcl({
  commandRunner = runBoundedWindowsCommand,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  fileOps,
  machineName = os.hostname(),
  platform = process.platform,
  randomId = randomUUID,
  systemRoot = process.env.SystemRoot || "C:\\Windows",
  tempDirectory = os.tmpdir(),
} = {}) {
  const ops = {
    lstat: (...args) => fs.promises.lstat(...args),
    readFile: (...args) => fs.promises.readFile(...args),
    unlink: (...args) => fs.promises.unlink(...args),
    ...fileOps,
  };
  let currentIdentityPromise;

  async function runSystemCommand(fileName, args, options = {}) {
    if (platform !== "win32") {
      throw privateAclError("windows_private_acl_unsupported_platform");
    }
    return commandRunner(systemExecutable(systemRoot, fileName), args, {
      ...options,
      timeoutMs: commandTimeoutMs,
    });
  }

  async function currentIdentity() {
    if (!currentIdentityPromise) {
      currentIdentityPromise = runSystemCommand("whoami.exe", [
        "/user",
        "/fo",
        "csv",
        "/nh",
      ]).then(({ stdout }) => {
        const text = outputBuffer(stdout).toString("utf8");
        const sid = text
          .match(/S-\d(?:-\d+){2,15}/iu)?.[0]
          ?.toUpperCase();
        if (!sid || !SID_PATTERN.test(sid)) {
          throw privateAclError("windows_private_acl_identity_failed");
        }
        const accountDomain = text.match(/^"?([^"\\,]+)\\/u)?.[1] || "";
        const localAccount =
          accountDomain === "." ||
          accountDomain.localeCompare(machineName, undefined, {
            sensitivity: "accent",
          }) === 0;
        return { localAccount, sid };
      });
    }
    return currentIdentityPromise;
  }

  async function readSavedDacl(target) {
    const savePath = path.join(
      tempDirectory,
      `.codexbridge-private-acl-${randomId()}.txt`,
    );
    try {
      await runSystemCommand("icacls.exe", [target, "/save", savePath]);
      const saved = await ops.readFile(savePath, "utf16le");
      const dacl = String(saved)
        .split(/\r?\n/u)
        .find((line) => line.startsWith("D:"));
      if (!dacl) {
        throw privateAclError("windows_private_acl_verification_failed");
      }
      return dacl;
    } finally {
      try {
        await ops.unlink(savePath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw privateAclError("windows_private_acl_cleanup_failed");
        }
      }
    }
  }

  async function verify(target, trustedSids, kind, identity) {
    const expectedPrincipalGroups = trustedSids.map((sid) =>
      sddlPrincipalsForSid(sid, {
        localAccount: sid === identity.sid && identity.localAccount,
      }));
    validateSavedDacl(
      await readSavedDacl(target),
      expectedPrincipalGroups,
      kind,
    );
  }

  async function apply(target, trustedSids, kind) {
    const permission = kind === "directory" ? "(OI)(CI)(F)" : "(F)";
    const grants = trustedSids.map((sid) => `*${sid}:${permission}`);
    await runSystemCommand("icacls.exe", [
      target,
      "/inheritance:r",
      "/grant:r",
      ...grants,
    ]);
  }

  async function replaceExplicitDacl(target, kind, identity) {
    const { stdout } = await runSystemCommand("WindowsPowerShell\\v1.0\\powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      POWERSHELL_REPLACE_DACL_SCRIPT,
    ], {
      environment: {
        [POWERSHELL_BINDING_KEYS.kind]: kind,
        [POWERSHELL_BINDING_KEYS.literalPath]: target,
        [POWERSHELL_BINDING_KEYS.userSid]: identity.sid,
      },
    });
    if (outputBuffer(stdout).toString("utf8").trim() !== PRIVATE_ACL_REPLACED_SENTINEL) {
      throw privateAclError("windows_private_acl_command_failed");
    }
  }

  async function applyAndVerify(target, trustedSids, kind, identity) {
    await apply(target, trustedSids, kind);
    try {
      await verify(target, trustedSids, kind, identity);
    } catch (error) {
      if (error?.code !== "windows_private_acl_verification_failed") {
        throw error;
      }
      // /inheritance:r removes inherited grants but intentionally preserves
      // pre-existing explicit grants. Replace the DACL in one Set-Acl update;
      // never use icacls /reset, which would briefly restore broad inheritance.
      await replaceExplicitDacl(target, kind, identity);
      await verify(target, trustedSids, kind, identity);
    }
  }

  async function securePath(target, { kind } = {}) {
    if (platform !== "win32") {
      throw privateAclError("windows_private_acl_unsupported_platform");
    }
    if (
      typeof target !== "string" ||
      !path.win32.isAbsolute(target) ||
      !["directory", "file"].includes(kind)
    ) {
      throw privateAclError("windows_private_acl_invalid_path");
    }

    const before = await ops.lstat(target);
    validatePathStats(before, kind);
    const identity = await currentIdentity();
    const trustedSids = [...new Set([identity.sid, ...TRUSTED_SYSTEM_SIDS])];
    await applyAndVerify(target, trustedSids, kind, identity);
    const after = await ops.lstat(target);
    validatePathStats(after, kind);
    if (statsIdentity(after) !== statsIdentity(before)) {
      throw privateAclError("windows_private_acl_path_changed");
    }
  }

  async function verifyPath(target, { kind } = {}) {
    if (platform !== "win32") {
      throw privateAclError("windows_private_acl_unsupported_platform");
    }
    if (
      typeof target !== "string" ||
      !path.win32.isAbsolute(target) ||
      !["directory", "file"].includes(kind)
    ) {
      throw privateAclError("windows_private_acl_invalid_path");
    }

    const before = await ops.lstat(target);
    validatePathStats(before, kind);
    const identity = await currentIdentity();
    const trustedSids = [...new Set([identity.sid, ...TRUSTED_SYSTEM_SIDS])];
    await verify(target, trustedSids, kind, identity);
    const after = await ops.lstat(target);
    validatePathStats(after, kind);
    if (statsIdentity(after) !== statsIdentity(before)) {
      throw privateAclError("windows_private_acl_path_changed");
    }
    return true;
  }

  return Object.freeze({ securePath, verifyPath });
}

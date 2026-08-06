import path from "node:path";

const MAX_DELETE_DEPTH = 64;

function deleteError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function hasParentTraversal(value) {
  return String(value).split(/[\\/]+/u).includes("..");
}

function normalize(value) {
  return path.resolve(String(value));
}

function authorizeChild(target, authorizedRoot, { allowRoot = false } = {}) {
  if (typeof target !== "string" || typeof authorizedRoot !== "string" || hasParentTraversal(target)) {
    throw deleteError("delete_path_traversal");
  }
  const root = normalize(authorizedRoot);
  const exact = normalize(target);
  const rootKey = process.platform === "win32" ? root.toLowerCase() : root;
  const exactKey = process.platform === "win32" ? exact.toLowerCase() : exact;
  if ((!allowRoot && exactKey === rootKey) || !exactKey.startsWith(`${rootKey}${path.sep}`)) {
    throw deleteError("delete_path_not_authorized");
  }
  return exact;
}

function rejectLink(stat) {
  if (stat?.isSymbolicLink?.() || stat?.isReparsePoint?.()) throw deleteError("delete_reparse_link_rejected");
}

function childName(entry) {
  return typeof entry === "string" ? entry : entry?.name;
}

export async function deleteAuthorizedTree({ target, authorizedRoot, fsApi }) {
  if (!fsApi || typeof fsApi.lstat !== "function") throw deleteError("delete_fs_api_invalid");
  const root = normalize(authorizedRoot);
  const exactTarget = authorizeChild(target, root);
  const rootStat = await fsApi.lstat(root);
  rejectLink(rootStat);
  if (!rootStat.isDirectory?.()) throw deleteError("delete_authorized_root_invalid");

  async function walk(exact, depth) {
    if (depth > MAX_DELETE_DEPTH) throw deleteError("delete_depth_exceeded");
    const authorized = authorizeChild(exact, root);
    const stat = await fsApi.lstat(authorized);
    rejectLink(stat);

    if (stat.isFile?.()) {
      if (typeof fsApi.unlink !== "function") throw deleteError("delete_fs_api_invalid");
      await fsApi.unlink(authorized);
      return;
    }
    if (!stat.isDirectory?.()) throw deleteError("delete_unsupported_file_type");
    if (typeof fsApi.readdir !== "function" || typeof fsApi.rmdir !== "function") {
      throw deleteError("delete_fs_api_invalid");
    }

    const entries = await fsApi.readdir(authorized, { withFileTypes: true });
    for (const entry of entries) {
      const name = childName(entry);
      if (typeof name !== "string" || name.length === 0 || name === "." || name === ".."
        || name.includes("/") || name.includes("\\") || path.isAbsolute(name)) {
        throw deleteError("delete_entry_not_authorized");
      }
      const child = authorizeChild(path.join(authorized, name), root);
      if (path.dirname(child) !== authorized) throw deleteError("delete_entry_not_authorized");
      await walk(child, depth + 1);
    }

    const finalStat = await fsApi.lstat(authorized);
    rejectLink(finalStat);
    if (!finalStat.isDirectory?.()) throw deleteError("delete_directory_changed");
    await fsApi.rmdir(authorized);
  }

  await walk(exactTarget, 0);
}

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

function childName(entry) {
  return typeof entry === "string" ? entry : entry?.name;
}

function requireDirectoryHandle(handle) {
  if (!handle || typeof handle.listChildren !== "function" || typeof handle.openChildNoFollow !== "function"
    || typeof handle.unlinkChildNoFollow !== "function" || typeof handle.rmdirChildNoFollow !== "function"
    || typeof handle.close !== "function") {
    throw deleteError("delete_no_follow_capability_invalid");
  }
  return handle;
}

function requireChildDescriptor(descriptor, expectedName) {
  if (!descriptor || descriptor.name !== expectedName || !["file", "directory"].includes(descriptor.kind)) {
    throw deleteError("delete_no_follow_descriptor_invalid");
  }
  if (descriptor.kind === "directory") requireDirectoryHandle(descriptor.handle);
  return descriptor;
}

export async function deleteAuthorizedTree({ target, authorizedRoot, fsApi }) {
  if (!fsApi || typeof fsApi.openDirectoryNoFollow !== "function") {
    throw deleteError("delete_no_follow_capability_required");
  }
  const root = normalize(authorizedRoot);
  const exactTarget = authorizeChild(target, root);
  const rootHandle = requireDirectoryHandle(await fsApi.openDirectoryNoFollow(root));
  const openHandles = new Set([rootHandle]);

  async function closeHandle(handle) {
    if (!openHandles.delete(handle)) return;
    await handle.close();
  }

  async function walk(parentHandle, descriptor, exact, depth) {
    if (depth > MAX_DELETE_DEPTH) throw deleteError("delete_depth_exceeded");
    authorizeChild(exact, root);
    if (descriptor.kind === "file") {
      await parentHandle.unlinkChildNoFollow(descriptor);
      return;
    }
    const directoryHandle = descriptor.handle;
    openHandles.add(directoryHandle);
    try {
      const entries = await directoryHandle.listChildren();
      for (const entry of entries) {
        const name = childName(entry);
        if (typeof name !== "string" || name.length === 0 || name === "." || name === ".."
          || name.includes("/") || name.includes("\\") || path.isAbsolute(name)) {
          throw deleteError("delete_entry_not_authorized");
        }
        const child = authorizeChild(path.join(exact, name), root);
        if (path.dirname(child) !== exact) throw deleteError("delete_entry_not_authorized");
        const childDescriptor = requireChildDescriptor(await directoryHandle.openChildNoFollow(name), name);
        await walk(directoryHandle, childDescriptor, child, depth + 1);
      }
    } finally {
      await closeHandle(directoryHandle);
    }
    await parentHandle.rmdirChildNoFollow(descriptor);
  }

  try {
    const relativeSegments = path.relative(root, exactTarget).split(path.sep);
    let parentHandle = rootHandle;
    let currentPath = root;
    for (let index = 0; index < relativeSegments.length; index += 1) {
      const name = relativeSegments[index];
      currentPath = authorizeChild(path.join(currentPath, name), root);
      const descriptor = requireChildDescriptor(await parentHandle.openChildNoFollow(name), name);
      if (index === relativeSegments.length - 1) {
        await walk(parentHandle, descriptor, currentPath, 0);
      } else {
        if (descriptor.kind !== "directory") throw deleteError("delete_target_parent_not_directory");
        parentHandle = descriptor.handle;
        openHandles.add(parentHandle);
      }
    }
  } finally {
    for (const handle of [...openHandles].reverse()) await closeHandle(handle);
  }
}

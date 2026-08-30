import fs from "node:fs";
import path from "node:path";

export function removeOwnedTemporaryDirectory(targetPath, {
  parentDirectory,
  requiredPrefix,
} = {}) {
  const target = path.resolve(String(targetPath || ""));
  const parent = path.resolve(String(parentDirectory || ""));
  const prefix = String(requiredPrefix || "");
  if (!targetPath || !parentDirectory || !prefix) {
    throw new Error("Temporary cleanup requires an exact target, parent, and prefix.");
  }
  if (!samePath(path.dirname(target), parent)) {
    throw new Error(`Temporary cleanup target is not a direct child of the authorized parent: ${target}`);
  }
  if (!path.basename(target).startsWith(prefix)) {
    throw new Error(`Temporary cleanup target does not have the required prefix: ${target}`);
  }
  if (!fs.existsSync(target)) {
    return Object.freeze({ removed: false, files: 0, directories: 0 });
  }
  const rootStat = fs.lstatSync(target);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Temporary cleanup target must be a real directory: ${target}`);
  }
  const counts = { files: 0, directories: 0 };
  removeDirectoryContentsNoFollow(target, counts);
  fs.rmdirSync(target);
  counts.directories += 1;
  return Object.freeze({ removed: true, ...counts });
}

function removeDirectoryContentsNoFollow(directoryPath, counts) {
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    const stat = fs.lstatSync(entryPath);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      removeDirectoryContentsNoFollow(entryPath, counts);
      fs.rmdirSync(entryPath);
      counts.directories += 1;
    } else {
      fs.unlinkSync(entryPath);
      counts.files += 1;
    }
  }
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

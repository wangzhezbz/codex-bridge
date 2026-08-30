export function assertReleaseTagMatchesPackageVersion({
  env = process.env,
  packageVersion = "",
} = {}) {
  const version = String(packageVersion || "").trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Invalid package version for release: ${packageVersion}`);
  }
  const refType = String(env?.GITHUB_REF_TYPE || "").trim().toLowerCase();
  const ref = String(env?.GITHUB_REF || "").trim();
  const refName = String(env?.GITHUB_REF_NAME || "").trim();
  const isTag = refType === "tag" || ref.startsWith("refs/tags/");
  if (!isTag) {
    return Object.freeze({ tagged: false, packageVersion: version, expectedTag: `v${version}` });
  }
  const actualTag = refName || ref.slice("refs/tags/".length);
  const expectedTag = `v${version}`;
  if (actualTag !== expectedTag) {
    throw new Error(`GitHub release tag ${actualTag || "(missing)"} does not match package version ${expectedTag}.`);
  }
  return Object.freeze({ tagged: true, packageVersion: version, expectedTag, actualTag });
}

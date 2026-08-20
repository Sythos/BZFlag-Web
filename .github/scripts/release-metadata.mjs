/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Sythos (https://www.sythos.net)
 *
 * MIT License
 *
 * Copyright (c) 2026 Sythos (https://www.sythos.net)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Build deterministic release metadata only after the package and container
 * artifacts have passed their gates. The upstream revision is read from the
 * repository manifest rather than inferred from the web repository commit.
 */

import { createHash } from "node:crypto";
import { mkdir, lstat, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = process.cwd();

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function git(args) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function posixPath(path) {
  return path.split(sep).join("/");
}

function relativePath(from, to, label) {
  const value = posixPath(relative(from, to));
  assert(value && value !== "." && !value.startsWith("../") && value !== ".." && !value.startsWith("/"), `${label} must remain relative to the release root`);
  return value;
}

function normalizedManifestPath(value, label) {
  const source = String(value || "");
  assert(source.startsWith("./"), `${label} must start with ./`);
  const normalized = posixPath(source.slice(2));
  assert(normalized && normalized !== "." && !normalized.startsWith("../") && !normalized.includes("/../") && !normalized.includes("//") && !normalized.includes("/./") && !normalized.endsWith("/.") && !normalized.startsWith("/"), `${label} must remain a normalized relative path`);
  return normalized;
}

async function collectFiles(root, relativeDirectory = "") {
  const directory = resolve(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const childRelative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const childPath = resolve(root, childRelative);
    const info = await lstat(childPath);
    assert(!info.isSymbolicLink(), `Release packages must not contain symlinks: ${childRelative}`);
    if (info.isDirectory()) {
      files.push(...await collectFiles(root, childRelative));
    } else if (info.isFile()) {
      files.push({ absolutePath: childPath, relativePath: childRelative });
    } else {
      throw new Error(`Unsupported release entry type: ${childRelative}`);
    }
  }
  return files;
}

async function hashFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function licenseForNotice(name) {
  switch (name) {
    case "COPYING": return "LGPL-2.1-only OR MPL-2.0";
    case "COPYING.LGPL": return "LGPL-2.1-only";
    case "COPYING.MPL": return "MPL-2.0";
    case "LICENSE-MIT":
    case "LEGAL-MIT.txt":
    case "NOTICE":
    case "ATTRIBUTION.md": return "MIT";
    case "AUTHORS": return "LGPL-2.1-only OR MPL-2.0";
    default: return undefined;
  }
}

function spdxLicense(value, label) {
  const source = String(value || "");
  if (source === "MIT" || source.includes("MIT")) return "MIT";
  if (source.includes("DejaVu")) return "LicenseRef-DejaVu-License";
  if (source.includes("LGPL-2.1-only") && source.includes("MPL-2.0")) return "LGPL-2.1-only OR MPL-2.0";
  if (source.includes("LGPL-2.1-only")) return "LGPL-2.1-only";
  if (source.includes("MPL-2.0")) return "MPL-2.0";
  throw new Error(`${label} has no supported SPDX license mapping: ${source}`);
}

function licenseInfoForFile(license) {
  return license.includes(" OR ") ? license.split(" OR ") : [license];
}

const releaseTag = option("--release-tag") || process.env.RELEASE_TAG;
const releaseDirectory = option("--release-dir") || "release";
assert(releaseTag, "A release tag is required");
assert(/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(releaseTag), `Invalid release tag: ${releaseTag}`);
assert(!/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(releaseDirectory), "Release directory must be relative");

const rootPackage = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
const upstream = rootPackage["x-upstream"];
assert(upstream && typeof upstream === "object", "package.json x-upstream metadata is required");
assert(upstream.project === "BZFlag", "x-upstream.project must be BZFlag");
assert(upstream.repository === "https://github.com/BZFlag-Dev/bzflag", "x-upstream.repository is invalid");
assert(/^[0-9a-f]{40}$/i.test(String(upstream.ref || "")), "x-upstream.ref must be a full commit SHA");
assert(String(upstream.version || "").trim(), "x-upstream.version is required");
assert(String(upstream.branch || "").trim(), "x-upstream.branch is required");

const releaseCommit = git(["rev-parse", "--verify", `${releaseTag}^{commit}`]);
const checkoutCommit = git(["rev-parse", "--verify", "HEAD"]);
assert(releaseCommit === checkoutCommit, `Checked-out commit ${checkoutCommit} does not match ${releaseTag} commit ${releaseCommit}`);

const releaseRoot = resolve(repositoryRoot, releaseDirectory);
const releaseRootRelative = relative(repositoryRoot, releaseRoot);
assert(releaseRootRelative && !releaseRootRelative.startsWith(`..${sep}`) && releaseRootRelative !== "..", "Release directory must remain inside the repository");
const clientDirectory = resolve(releaseRoot, `bzflag-web-client-${releaseTag.slice(1)}`);
const serverDirectory = resolve(releaseRoot, `bzflag-web-server-${releaseTag.slice(1)}`);
await mkdir(releaseRoot, { recursive: true });

for (const [path, marker] of [[clientDirectory, "client"], [serverDirectory, "server"]]) {
  try {
    assert((await stat(path)).isDirectory(), `Release ${marker} directory is missing: ${path}`);
  } catch (error) {
    throw new Error(`Release ${marker} directory is missing: ${path} (${error.message})`);
  }
}
for (const [path, marker] of [[`${clientDirectory}/dist`, "client/dist"], [`${serverDirectory}/dist`, "server/dist"]]) {
  try {
    assert((await stat(path)).isDirectory(), `Release ${marker} build output is missing: ${path}`);
  } catch (error) {
    throw new Error(`Release ${marker} build output is missing: ${path} (${error.message})`);
  }
}

const upstreamRecord = {
  project: upstream.project,
  version: upstream.version,
  branch: upstream.branch,
  ref: upstream.ref,
  repository: upstream.repository,
};

const clientAssetManifestPath = resolve(clientDirectory, "assets/asset-manifest.json");
let clientAssetManifest;
try {
  clientAssetManifest = JSON.parse(await readFile(clientAssetManifestPath, "utf8"));
} catch (error) {
  throw new Error(`Release client asset manifest is missing or invalid: ${error.message}`);
}
assert(clientAssetManifest && Array.isArray(clientAssetManifest.entries), "client/assets/asset-manifest.json entries are required");
assert(clientAssetManifest["relative-to"] === "./", "client/assets/asset-manifest.json relative-to must be ./");
assert(clientAssetManifest.upstream && typeof clientAssetManifest.upstream === "object", "client/assets/asset-manifest.json upstream provenance is required");
for (const field of ["project", "version", "ref", "branch"]) {
  assert(String(clientAssetManifest.upstream[field] || "") === String(upstream[field] || ""), `client asset manifest upstream.${field} does not match package.json x-upstream.${field}`);
}
const assetEntries = new Map();
for (const [index, entry] of clientAssetManifest.entries.entries()) {
  assert(entry && typeof entry === "object", `client asset manifest entry ${index} must be an object`);
  const path = normalizedManifestPath(entry.path, `client asset manifest entry ${index} path`);
  assert(!assetEntries.has(path), `client asset manifest contains a duplicate path: ${path}`);
  assert(String(entry.source || "").trim(), `client asset manifest entry ${path} source is required`);
  assetEntries.set(path, {
    license: spdxLicense(entry.license, `client asset manifest entry ${path}`),
    source: String(entry.source),
  });
}

const clientReleaseName = basename(clientDirectory);
const serverReleaseName = basename(serverDirectory);
const releaseFileRecords = [];
const releasePackageIds = {
  release: "SPDXRef-Package-BZFlag-Web-Release",
  client: "SPDXRef-Package-BZFlag-Web-Client",
  server: "SPDXRef-Package-BZFlag-Web-Gateway",
  originalAssets: "SPDXRef-Package-BZFlag-Web-Client-Original-Assets",
  upstreamAssets: "SPDXRef-Package-BZFlag-Upstream-Assets",
  dejaVuAssets: "SPDXRef-Package-BZFlag-DejaVu-Assets",
};

function packageForFile(releaseName, localPath, license) {
  const noticeLicense = licenseForNotice(basename(localPath));
  if (noticeLicense) return { id: releasePackageIds.release, source: "Project license and attribution material" };
  if (releaseName === clientReleaseName) {
    if (!localPath.startsWith("assets/")) return { id: releasePackageIds.client, source: "Sythos original project source" };
    if (license === "LicenseRef-DejaVu-License") return { id: releasePackageIds.dejaVuAssets, source: "DejaVu font material with preserved local notice" };
    if (license === "LGPL-2.1-only OR MPL-2.0") return { id: releasePackageIds.upstreamAssets, source: `BZFlag ${upstreamRecord.version} pinned upstream asset subset` };
    return { id: releasePackageIds.originalAssets, source: "Sythos original project asset or metadata" };
  }
  if (releaseName === serverReleaseName) return { id: releasePackageIds.server, source: "Sythos original gateway project source" };
  throw new Error(`Unknown release package directory: ${releaseName}`);
}

async function addReleaseFiles(root, releaseName) {
  for (const entry of await collectFiles(root)) {
    const localPath = posixPath(entry.relativePath);
    let license;
    let source;
    const noticeLicense = licenseForNotice(basename(localPath));
    if (noticeLicense) {
      license = noticeLicense;
      source = "Project license and attribution material";
    } else if (releaseName === clientReleaseName && localPath.startsWith("assets/")) {
      const asset = assetEntries.get(localPath);
      assert(asset, `client asset is missing from asset-manifest.json: ${localPath}`);
      license = asset.license;
      source = asset.source;
    } else {
      license = "MIT";
      source = releaseName === clientReleaseName ? "Sythos original project source" : "Sythos original gateway project source";
    }
    const component = packageForFile(releaseName, localPath, license);
    const fileName = relativePath(releaseRoot, entry.absolutePath, `${releaseName}/${localPath}`);
    const fileHash = await hashFile(entry.absolutePath);
    const idPart = fileName.replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "root";
    releaseFileRecords.push({
      SPDXID: `SPDXRef-File-${idPart}-${fileHash.slice(0, 12)}`,
      fileName,
      checksums: [{ algorithm: "SHA256", checksum: fileHash }],
      licenseConcluded: license,
      licenseInfoInFiles: licenseInfoForFile(license),
      copyrightText: license === "MIT"
        ? "Copyright (c) 2026 Sythos (https://www.sythos.net)"
        : license === "LicenseRef-DejaVu-License"
          ? "Copyright holders identified in the DejaVu font license notice"
          : "Copyright holders and contributors identified by the BZFlag upstream notices",
      comment: `Provenance: ${source}; Upstream reference: ${upstreamRecord.ref}`,
      packageId: component.id,
    });
  }
}

await addReleaseFiles(clientDirectory, clientReleaseName);
await addReleaseFiles(serverDirectory, serverReleaseName);
assert(releaseFileRecords.length > 0, "Release file inventory is empty");
const inventoryPaths = new Set();
for (const file of releaseFileRecords) {
  assert(!inventoryPaths.has(file.fileName), `Release file inventory contains a duplicate path: ${file.fileName}`);
  inventoryPaths.add(file.fileName);
}
for (const path of assetEntries.keys()) {
  assert(inventoryPaths.has(`${clientReleaseName}/${path}`), `Asset manifest path is not present in the release: ${path}`);
}

const sourceDateEpoch = Number.parseInt(process.env.SOURCE_DATE_EPOCH || "", 10);
const generatedAt = Number.isSafeInteger(sourceDateEpoch) && sourceDateEpoch >= 0
  ? new Date(sourceDateEpoch * 1000).toISOString()
  : git(["show", "-s", "--format=%cI", releaseCommit]);
const repository = process.env.GITHUB_REPOSITORY || "Sythos/BZFlag-Web";
const releaseUrl = `https://github.com/${repository}/releases/tag/${releaseTag}`;

const manifest = [
  "BZFlag Web Client release manifest",
  `Release tag: ${releaseTag}`,
  `Release commit: ${releaseCommit}`,
  `Upstream project: ${upstreamRecord.project}`,
  `Upstream version: ${upstreamRecord.version}`,
  `Upstream branch: ${upstreamRecord.branch}`,
  `Upstream ref: ${upstreamRecord.ref}`,
  `Upstream repository: ${upstreamRecord.repository}`,
  `File inventory: ${releaseFileRecords.length} release files with SHA-256 and SPDX license records in sbom.spdx.json`,
  "License policy: original project material is MIT; pinned BZFlag assets retain LGPL-2.1-only OR MPL-2.0; DejaVu assets retain their local notice.",
  `Generated at: ${generatedAt}`,
  "",
].join("\n");
await writeFile(resolve(releaseRoot, "RELEASE-MANIFEST.txt"), manifest, "utf8");

const dejaVuLicenseRecord = releaseFileRecords.find((file) => file.fileName === `${clientReleaseName}/assets/upstream/fonts/DejaVu.License`);
assert(dejaVuLicenseRecord, "Release DejaVu license notice is missing from the file inventory");
const dejaVuLicenseText = await readFile(resolve(clientDirectory, "assets/upstream/fonts/DejaVu.License"), "utf8");
const packageDefinitions = [
  {
    SPDXID: releasePackageIds.release,
    name: "BZFlag Web release",
    versionInfo: releaseTag.slice(1),
    downloadLocation: releaseUrl,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    filesAnalyzed: true,
    copyrightText: "Copyright (c) 2026 Sythos (https://www.sythos.net) and upstream contributors",
  },
  {
    SPDXID: releasePackageIds.client,
    name: "BZFlag Web Client original source",
    versionInfo: releaseTag.slice(1),
    downloadLocation: releaseUrl,
    licenseConcluded: "MIT",
    licenseDeclared: "MIT",
    filesAnalyzed: true,
    copyrightText: "Copyright (c) 2026 Sythos (https://www.sythos.net)",
  },
  {
    SPDXID: releasePackageIds.server,
    name: "BZFlag Web gateway original source",
    versionInfo: releaseTag.slice(1),
    downloadLocation: releaseUrl,
    licenseConcluded: "MIT",
    licenseDeclared: "MIT",
    filesAnalyzed: true,
    copyrightText: "Copyright (c) 2026 Sythos (https://www.sythos.net)",
  },
  {
    SPDXID: releasePackageIds.originalAssets,
    name: "BZFlag Web original client assets and metadata",
    versionInfo: releaseTag.slice(1),
    downloadLocation: releaseUrl,
    licenseConcluded: "MIT",
    licenseDeclared: "MIT",
    filesAnalyzed: true,
    copyrightText: "Copyright (c) 2026 Sythos (https://www.sythos.net)",
  },
  {
    SPDXID: releasePackageIds.upstreamAssets,
    name: `BZFlag upstream asset subset ${upstreamRecord.version}`,
    versionInfo: upstreamRecord.version,
    downloadLocation: upstreamRecord.repository,
    licenseConcluded: "LGPL-2.1-only OR MPL-2.0",
    licenseDeclared: "LGPL-2.1-only OR MPL-2.0",
    filesAnalyzed: true,
    copyrightText: "Copyright holders and contributors identified by the BZFlag upstream notices",
    externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: `pkg:github/BZFlag-Dev/bzflag@${upstreamRecord.ref}` }],
  },
  {
    SPDXID: releasePackageIds.dejaVuAssets,
    name: "DejaVu font asset subset",
    versionInfo: upstreamRecord.version,
    downloadLocation: upstreamRecord.repository,
    licenseConcluded: "LicenseRef-DejaVu-License",
    licenseDeclared: "LicenseRef-DejaVu-License",
    filesAnalyzed: true,
    copyrightText: "Copyright holders identified in the DejaVu font license notice",
    externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: `pkg:github/BZFlag-Dev/bzflag@${upstreamRecord.ref}` }],
  },
];
const fileRecordsForSpdx = releaseFileRecords.map(({ packageId, ...file }) => file);
const componentPackageIds = packageDefinitions
  .map((packageData) => packageData.SPDXID)
  .filter((packageId) => packageId !== releasePackageIds.release);
const relationships = [
  { spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: releasePackageIds.release },
  ...componentPackageIds.map((packageId) => ({
    spdxElementId: releasePackageIds.release,
    relationshipType: "CONTAINS",
    relatedSpdxElement: packageId,
  })),
  ...releaseFileRecords.map(({ SPDXID, packageId }) => ({
    spdxElementId: packageId,
    relationshipType: "CONTAINS",
    relatedSpdxElement: SPDXID,
  })),
];
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `bzflag-web-${releaseTag}`,
  documentNamespace: `${releaseUrl}/sbom/${releaseCommit}`,
  creationInfo: {
    created: generatedAt,
    creators: ["Tool: BZFlag-Web release-metadata.mjs", "Organization: Sythos"],
  },
  packages: packageDefinitions,
  files: fileRecordsForSpdx,
  hasExtractedLicensingInfos: [{
    licenseId: "LicenseRef-DejaVu-License",
    name: "DejaVu font license",
    extractedText: dejaVuLicenseText,
  }],
  relationships,
};
await writeFile(resolve(releaseRoot, "sbom.spdx.json"), `${JSON.stringify(sbom, null, 2)}\n`, "utf8");

const provenance = {
  schemaVersion: 1,
  generatedAt,
  repository,
  releaseTag,
  releaseCommit,
  workflowCommit: process.env.GITHUB_SHA || null,
  workflow: process.env.GITHUB_WORKFLOW || "Release",
  runId: process.env.GITHUB_RUN_ID || null,
  source: {
    repository: `https://github.com/${repository}`,
    ref: releaseTag,
    commit: releaseCommit,
  },
  upstream: upstreamRecord,
  artifacts: [
    `bzflag-web-client-${releaseTag.slice(1)}.zip`,
    `bzflag-web-server-${releaseTag.slice(1)}.zip`,
    `bzflag-web-server-${releaseTag.slice(1)}.tar.gz`,
    `bzflag-web-server-docker-${releaseTag.slice(1)}.tar`,
    `bzflag-web-server-docker-${releaseTag.slice(1)}.tar.gz`,
  ],
};
await writeFile(resolve(releaseRoot, "build-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");

console.log(`Wrote release manifest, SPDX SBOM and build provenance for ${releaseTag} (${releaseCommit}).`);

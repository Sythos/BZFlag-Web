/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Sythos (https://www.sythos.net)
 *
 * Read-only release bundle gate. It verifies the generated archives, checksum
 * closure, SPDX SBOM, provenance record, Docker evidence and the unpacked
 * package inventory before an artifact can be uploaded or published.
 */

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const failures = [];

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function fail(message) {
  failures.push(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function posix(path) {
  return path.split(sep).join("/");
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`${label}: invalid or unreadable JSON (${error.message})`);
    return null;
  }
}

async function requireFile(path, label = path) {
  try {
    const info = await stat(path);
    assert(info.isFile() && info.size > 0, `${label}: missing or empty`);
  } catch (error) {
    fail(`${label}: missing (${error.code || error.message})`);
  }
}

async function collectFiles(root, relativeDirectory = "") {
  const directory = resolve(root, relativeDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    fail(`${relativeDirectory || root}: cannot enumerate (${error.code || error.message})`);
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const childRelative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const child = resolve(root, childRelative);
    const info = await lstat(child);
    if (info.isSymbolicLink()) {
      fail(`release package must not contain a symlink: ${childRelative}`);
    } else if (info.isDirectory()) {
      files.push(...await collectFiles(root, childRelative));
    } else if (info.isFile()) {
      files.push({ absolute: child, relative: posix(childRelative) });
    } else {
      fail(`unsupported release entry: ${childRelative}`);
    }
  }
  return files;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const releaseTag = option("--release-tag") || process.env.RELEASE_TAG;
const releaseDirectory = option("--release-dir") || "release";
assert(/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(releaseTag || ""), `invalid release tag: ${releaseTag || "<missing>"}`);
assert(!/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(releaseDirectory), "release directory must be relative");

const root = resolve(process.cwd(), releaseDirectory);
const version = releaseTag?.slice(1);
const clientName = `bzflag-web-client-${version}`;
const serverName = `bzflag-web-server-${version}`;
const requiredArchives = [
  `${clientName}.zip`,
  `${serverName}.zip`,
  `${serverName}.tar.gz`,
  `bzflag-web-server-docker-${version}.tar`,
  `bzflag-web-server-docker-${version}.tar.gz`,
];

for (const archive of requiredArchives) await requireFile(resolve(root, archive), `release/${archive}`);
for (const path of [
  "RELEASE-MANIFEST.txt",
  "SHA256SUMS.txt",
  "sbom.spdx.json",
  "build-provenance.json",
  "docker/image-inspect.json",
  "docker/Dockerfile",
]) await requireFile(resolve(root, path), `release/${path}`);

const releaseEntries = await readdir(root, { withFileTypes: true }).catch((error) => {
  fail(`release directory cannot be read (${error.code || error.message})`);
  return [];
});
const topLevelFiles = new Set(releaseEntries.filter((entry) => entry.isFile()).map((entry) => entry.name));
const checksumPath = resolve(root, "SHA256SUMS.txt");
const checksumSource = await readFile(checksumPath, "utf8").catch(() => "");
const checksums = new Map();
for (const line of checksumSource.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
  const match = line.match(/^([0-9a-f]{64})\s+(.+)$/i);
  if (!match) {
    fail(`SHA256SUMS.txt: malformed line: ${line}`);
    continue;
  }
  const name = match[2].replace(/^\.\//, "").replace(/^release\//, "");
  if (name.includes("/") || name === "SHA256SUMS.txt") fail(`SHA256SUMS.txt: only non-checksum top-level files may be listed: ${name}`);
  if (checksums.has(name)) fail(`SHA256SUMS.txt: duplicate entry: ${name}`);
  checksums.set(name, match[1].toLowerCase());
}
for (const archive of [...topLevelFiles].filter((name) => name !== "SHA256SUMS.txt")) {
  if (!checksums.has(archive)) fail(`SHA256SUMS.txt: missing checksum for ${archive}`);
}
for (const name of checksums.keys()) {
  if (!topLevelFiles.has(name)) fail(`SHA256SUMS.txt: references missing top-level file ${name}`);
  else if ((await sha256(resolve(root, name))) !== checksums.get(name)) fail(`SHA256SUMS.txt: checksum mismatch for ${name}`);
}

const manifest = await readFile(resolve(root, "RELEASE-MANIFEST.txt"), "utf8").catch(() => "");
assert(manifest.includes(`Release tag: ${releaseTag}`), "RELEASE-MANIFEST.txt: release tag is missing or mismatched");
const manifestCommit = manifest.match(/^Release commit:\s*([0-9a-f]{40})$/im)?.[1];
assert(Boolean(manifestCommit), "RELEASE-MANIFEST.txt: a 40-character release commit is required");

const provenance = await readJson(resolve(root, "build-provenance.json"), "build-provenance.json");
if (provenance) {
  assert(provenance.releaseTag === releaseTag, "build-provenance.json: releaseTag mismatch");
  assert(/^[0-9a-f]{40}$/i.test(String(provenance.releaseCommit || "")), "build-provenance.json: releaseCommit must be a full SHA");
  assert(provenance.releaseCommit === manifestCommit, "build-provenance.json: releaseCommit differs from RELEASE-MANIFEST.txt");
  assert(provenance.source?.ref === releaseTag, "build-provenance.json: source.ref mismatch");
  assert(provenance.source?.commit === provenance.releaseCommit, "build-provenance.json: source.commit mismatch");
  const artifacts = new Set(provenance.artifacts || []);
  for (const archive of requiredArchives) assert(artifacts.has(archive), `build-provenance.json: artifact is not recorded: ${archive}`);
}

const sbom = await readJson(resolve(root, "sbom.spdx.json"), "sbom.spdx.json");
if (sbom) {
  assert(sbom.spdxVersion === "SPDX-2.3", "sbom.spdx.json: SPDX-2.3 is required");
  assert(sbom.SPDXID === "SPDXRef-DOCUMENT", "sbom.spdx.json: document SPDXID is invalid");
  assert(sbom.name === `bzflag-web-${releaseTag}`, "sbom.spdx.json: release name mismatch");
  assert(Array.isArray(sbom.packages) && sbom.packages.length > 0, "sbom.spdx.json: package closure is empty");
  assert(Array.isArray(sbom.files) && sbom.files.length > 0, "sbom.spdx.json: file inventory is empty");
  assert(Array.isArray(sbom.relationships) && sbom.relationships.length > 0, "sbom.spdx.json: relationships are required");
}

const dockerfile = await readFile(resolve(root, "docker/Dockerfile"), "utf8").catch(() => "");
assert(/FROM\s+node:26\.7\.0-alpine\b/i.test(dockerfile), "release/docker/Dockerfile: pinned Node image is missing");
assert(/gateway\.js/.test(dockerfile), "release/docker/Dockerfile: compiled gateway entrypoint is missing");
const dockerInspect = await readJson(resolve(root, "docker/image-inspect.json"), "docker/image-inspect.json");
assert(Array.isArray(dockerInspect) && dockerInspect.length > 0, "docker/image-inspect.json: real Docker inspect output is required");

for (const [name, required] of [[clientName, ["package.json", "package-lock.json", "index.html", "service-worker.js", "dist/app.js", "dist/protocol.js", "dist/world.js", "dist/game.js", "dist/renderer.js", "dist/service-worker.js"]], [serverName, ["package.json", "package-lock.json", "gateway.ts", "index.html", "dist/gateway.js"]]]) {
  const packageRoot = resolve(root, name);
  for (const path of required) await requireFile(resolve(packageRoot, path), `release/${name}/${path}`);
  const packageFiles = await collectFiles(packageRoot, "");
  assert(!packageFiles.some(({ relative: path }) => path === "node_modules" || path.startsWith("node_modules/")), `release/${name}: node_modules must not be packaged`);
  if (sbom?.files) {
    const prefix = `${name}/`;
    const sbomFiles = new Map(sbom.files.map((file) => [posix(file.fileName || ""), file]));
    for (const entry of packageFiles) {
      const record = sbomFiles.get(`${prefix}${entry.relative}`);
      assert(Boolean(record), `sbom.spdx.json: package file is outside inventory: ${prefix}${entry.relative}`);
      if (record) {
        assert(record.checksums?.some((item) => item.algorithm === "SHA256"), `sbom.spdx.json: SHA256 is missing for ${prefix}${entry.relative}`);
        const digest = record.checksums.find((item) => item.algorithm === "SHA256")?.checksum;
        if (digest) assert((await sha256(entry.absolute)) === digest.toLowerCase(), `sbom.spdx.json: checksum mismatch for ${prefix}${entry.relative}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Release ${releaseTag} bundle closure, checksums, SPDX SBOM, provenance and Docker evidence passed.`);
}

/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) Sythos (https://www.sythos.net)
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
 * Repository-local compliance checks. They intentionally use only Node.js
 * built-ins so the checks are reproducible before application dependencies
 * have been installed.
 */

import { access, readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

const failures = [];
const rootFiles = ["COPYING", "COPYING.LGPL", "COPYING.MPL", "LICENSE-MIT"];
const provenanceFiles = ["NOTICE", "ATTRIBUTION.md", "AUTHORS"];
const metadataFiles = ["package.json", "client/package.json", "client/manifest.webmanifest", "server/config.example.json"];
const dependencyLockFiles = ["client/package-lock.json", "server/package-lock.json"];
const metadataObjects = new Map();

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

for (const file of rootFiles) {
  if (!(await exists(file))) {
    failures.push(`missing required license file: ${file}`);
  }
}

for (const file of provenanceFiles) {
  if (!(await exists(file))) failures.push(`missing required provenance file: ${file}`);
}

for (const file of metadataFiles) {
  if (!(await exists(file))) {
    failures.push(`missing required project metadata: ${file}`);
    continue;
  }
  let metadata;
  try {
    metadata = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    failures.push(`${file}: invalid JSON (${error.message})`);
    continue;
  }
  metadataObjects.set(file, metadata);
  const source = JSON.stringify(metadata).toLowerCase();
  if (!source.includes("mit")) failures.push(`${file}: missing MIT license metadata`);
  if (!source.includes("sythos") || !source.includes("sythos.net")) {
    failures.push(`${file}: missing Sythos attribution metadata`);
  }
  const licenseHeader = String(metadata["x-license-header"] || metadata._license || "");
  for (const marker of ["SPDX-License-Identifier: MIT", "Permission is hereby granted, free of charge", "THE SOFTWARE IS PROVIDED \"AS IS\""]) {
    if (!licenseHeader.includes(marker)) failures.push(`${file}: license metadata is missing ${marker}`);
  }
  if (file.endsWith("package.json") && metadata.license !== "MIT") {
    failures.push(`${file}: new package metadata must declare license MIT`);
  }
  if ((file === "client/package.json" || file === "server/package.json")
    && metadata.devDependencies?.typescript !== "7.0.2") {
    failures.push(`${file}: TypeScript must be pinned to 7.0.2`);
  }
}

for (const file of dependencyLockFiles) {
  if (!(await exists(file))) {
    failures.push(`missing required dependency lockfile: ${file}`);
    continue;
  }
  try {
    const lock = JSON.parse(await readFile(file, "utf8"));
    if (lock.packages?.[""]?.devDependencies?.typescript !== "7.0.2") {
      failures.push(`${file}: root TypeScript dependency must be pinned to 7.0.2`);
    }
    if (lock.packages?.["node_modules/typescript"]?.version !== "7.0.2") {
      failures.push(`${file}: installed TypeScript lock entry must be 7.0.2`);
    }
  } catch (error) {
    failures.push(`${file}: invalid JSON (${error.message})`);
  }
}

const upstreamMetadata = metadataObjects.get("package.json")?.["x-upstream"];
if (upstreamMetadata?.ref) {
  for (const file of ["NOTICE", "ATTRIBUTION.md"]) {
    if (await exists(file)) {
      const source = await readFile(file, "utf8");
      if (!source.includes(String(upstreamMetadata.ref))) failures.push(`${file}: missing pinned upstream revision ${upstreamMetadata.ref}`);
    }
  }
}
if (await exists("NOTICE")) {
  const source = await readFile("NOTICE", "utf8");
  for (const marker of ["LGPL-2.1", "MPL-2.0", "Sythos (https://www.sythos.net)"]) {
    if (!source.includes(marker)) failures.push(`NOTICE: missing provenance marker ${marker}`);
  }
}
if (await exists("ATTRIBUTION.md")) {
  const source = await readFile("ATTRIBUTION.md", "utf8");
  for (const marker of ["Co-author: Sythos (https://www.sythos.net)", "LGPL-2.1/MPL-2.0", "LICENSE-MIT"]) {
    if (!source.includes(marker)) failures.push(`ATTRIBUTION.md: missing provenance marker ${marker}`);
  }
}

async function inspectAssetManifest() {
  const manifestPath = "client/assets/asset-manifest.json";
  if (!(await exists(manifestPath))) {
    failures.push(`${manifestPath}: missing asset provenance manifest`);
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    failures.push(`${manifestPath}: invalid JSON (${error.message})`);
    return;
  }

  const licenseText = String(manifest._license || "");
  for (const marker of [
    "SPDX-License-Identifier: MIT",
    "Copyright (c) 2026 Sythos (https://www.sythos.net)",
    "MIT License",
    "Permission is hereby granted, free of charge",
    "THE SOFTWARE IS PROVIDED \"AS IS\"",
  ]) {
    if (!licenseText.includes(marker)) failures.push(`${manifestPath}: _license is missing ${marker}`);
  }

  const upstream = metadataObjects.get("package.json")?.["x-upstream"];
  if (!upstream || typeof upstream !== "object") {
    failures.push(`${manifestPath}: cannot compare asset provenance without package.json x-upstream metadata`);
  } else {
    for (const field of ["project", "version", "ref", "branch"]) {
      if (String(manifest.upstream?.[field] || "") !== String(upstream[field] || "")) {
        failures.push(`${manifestPath}: upstream.${field} does not match package.json x-upstream.${field}`);
      }
    }
  }

  if (manifest["relative-to"] !== "./") failures.push(`${manifestPath}: relative-to must be ./`);
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    failures.push(`${manifestPath}: entries must be a non-empty array`);
    return;
  }

  const listed = new Set();
  const clientRoot = resolve("client");
  const pathInsideClient = (relativePath) => {
    const target = resolve(clientRoot, relativePath);
    const outside = relative(clientRoot, target);
    return outside === "" || (outside !== ".." && !outside.startsWith(`..${sep}`) && !outside.includes(`..${sep}`));
  };

  for (const [index, entry] of manifest.entries.entries()) {
    const label = `${manifestPath}: entries[${index}]`;
    if (!entry || typeof entry !== "object") {
      failures.push(`${label}: entry must be an object`);
      continue;
    }
    const assetPath = typeof entry.path === "string" ? entry.path : "";
    const relativePath = assetPath.startsWith("./") ? assetPath.slice(2) : "";
    if (!relativePath || assetPath.includes("://") || relativePath.split(/[\\/]/).includes("..")) {
      failures.push(`${label}: path must be a relative local path below client/: ${assetPath}`);
      continue;
    }
    if (!pathInsideClient(relativePath)) {
      failures.push(`${label}: path escapes client/: ${assetPath}`);
      continue;
    }
    if (listed.has(relativePath)) failures.push(`${label}: duplicate path ${assetPath}`);
    listed.add(relativePath);
    if (!(await exists(resolve(clientRoot, relativePath)))) failures.push(`${label}: missing file ${assetPath}`);
    if (typeof entry.license !== "string" || !entry.license.trim()) failures.push(`${label}: license is required`);
    if (typeof entry.source !== "string" || !entry.source.trim()) failures.push(`${label}: source is required`);

    if (relativePath.startsWith("assets/upstream/")) {
      if (relativePath === "assets/upstream/README.md") {
        if (!String(entry.license).includes("MIT")) failures.push(`${label}: the project-authored provenance README must remain MIT-licensed`);
      } else if (relativePath.startsWith("assets/upstream/fonts/")) {
        if (!String(entry.license).includes("DejaVu.License")) failures.push(`${label}: DejaVu font material must point to DejaVu.License`);
      } else if (!String(entry.license).includes("LGPL-2.1-only") || !String(entry.license).includes("MPL-2.0")) {
        failures.push(`${label}: upstream BZFlag material must retain LGPL-2.1/MPL-2.0 provenance`);
      }
    } else if (!String(entry.license).includes("MIT")) {
      failures.push(`${label}: original project asset/metadata must be MIT-licensed`);
    }
  }

  async function inspectAssetTree(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await inspectAssetTree(path);
        continue;
      }
      const relativePath = relative(clientRoot, path).replaceAll("\\", "/");
      if (!listed.has(relativePath)) failures.push(`${manifestPath}: asset file is not listed: ./${relativePath}`);
    }
  }
  await inspectAssetTree(resolve(clientRoot, "assets"));
}

await inspectAssetManifest();

if (!(await exists("client/assets/upstream/README.md"))) {
  failures.push("client/assets/upstream/README.md: missing upstream asset provenance manifest");
}

if (await exists("README.md")) {
  const readme = (await readFile("README.md", "utf8")).toLowerCase();
  const requiredReadmeMarkers = [
    "bzflag web client",
    "html5",
    "node.js",
    "github.com/sythos/bzflag-web/issues",
    "github.com/sythos/bzflag-web/commits",
    "github.com/sythos/bzflag-web/releases",
    "gateway",
    "bridge",
    "webgpu",
    "webgl2",
    "disclaimer",
  ];
  for (const marker of requiredReadmeMarkers) {
    if (!readme.includes(marker)) {
      failures.push(`README.md: missing required marker ${marker}`);
    }
  }
}

const requiredCredits = ["server/index.html", "client/index.html", "client/web_game_run.html"];
for (const file of requiredCredits) {
  if (!(await exists(file))) {
    continue;
  }
  const source = (await readFile(file, "utf8")).toLowerCase();
  if (!source.includes("sythos (https://www.sythos.net)")) {
    failures.push(`${file}: missing Sythos credit`);
  }
}

const sourceExtensions = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".js", ".mjs", ".ts", ".tsx", ".css", ".html", ".sh", ".yml", ".yaml", ".json", ".webmanifest"]);
const ignoredDirectories = new Set(["node_modules", "dist", "build", "vendor", "assets", "static"]);

async function inspectTree(directory) {
  if (!(await exists(directory))) {
    return;
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await inspectTree(path);
      continue;
    }
    if (!sourceExtensions.has(extname(entry.name).toLowerCase())) {
      continue;
    }
    const source = await readFile(path, "utf8");
    const hasLicenseMarker = /SPDX-License-Identifier\s*:/i.test(source)
      || /MIT License/i.test(source)
      || /Permission is hereby granted/i.test(source)
      || /GNU Lesser General Public License/i.test(source)
      || /Mozilla Public License/i.test(source);
    if (!hasLicenseMarker) {
      failures.push(`${relative(".", path)}: missing SPDX/license header`);
    }
  }
}

await inspectTree("server");
await inspectTree("client");
await inspectTree(".github");

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("License, attribution, README and source-header compliance checks passed.");
}

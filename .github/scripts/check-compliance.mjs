/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) Sythos (https://www.sythos.net)
 *
 * Repository-local compliance checks. They intentionally use only Node.js
 * built-ins so the checks are reproducible before application dependencies
 * have been installed.
 */

import { access, readdir, readFile } from "node:fs/promises";
import { join, extname, relative } from "node:path";

const failures = [];
const rootFiles = ["COPYING", "COPYING.LGPL", "COPYING.MPL", "LICENSE-MIT"];
const metadataFiles = ["package.json", "client/package.json", "client/manifest.webmanifest", "server/config.example.json"];

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
  const source = JSON.stringify(metadata).toLowerCase();
  if (!source.includes("mit")) failures.push(`${file}: missing MIT license metadata`);
  if (!source.includes("sythos") || !source.includes("sythos.net")) {
    failures.push(`${file}: missing Sythos attribution metadata`);
  }
  if (file.endsWith("package.json") && metadata.license !== "MIT") {
    failures.push(`${file}: new package metadata must declare license MIT`);
  }
}

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

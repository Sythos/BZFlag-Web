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
 * Deterministic checks for the supported Node.js runtime and locked TypeScript
 * package metadata. All paths are repository-relative so the check works from
 * a checkout, a release workspace, or a container build context.
 */

import { readFile } from "node:fs/promises";

const NODE_ENGINE = ">=26.7.0";
const NODE_VERSION = "26.7.0";
const NODE_IMAGE = "26.7.0-alpine";
const UNDICI_TYPES_VERSION = "8.10.0";
const NODE_TYPES_VERSION = "26.2.0";

const packageFiles = [
  "package.json",
  "client/package.json",
  "server/package.json",
];
const lockFiles = [
  "client/package-lock.json",
  "server/package-lock.json",
];
const workflowFiles = [
  ".github/workflows/ci.yml",
  ".github/workflows/compliance.yml",
  ".github/workflows/release.yml",
];
const failures = [];

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    failures.push(`${path}: cannot read valid JSON (${error.message})`);
    return null;
  }
}

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    failures.push(`${path}: cannot read file (${error.message})`);
    return "";
  }
}

function expectValue(path, label, actual, expected) {
  if (actual !== expected) {
    failures.push(`${path}: ${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}`);
  }
}

function checkPackageMetadata(path, metadata, { checkUndici = false, checkNodeTypes = false, checkOverride = false } = {}) {
  if (!metadata) return;
  expectValue(path, "engines.node", metadata.engines?.node, NODE_ENGINE);
  if (checkUndici) expectValue(path, "devDependencies.undici-types", metadata.devDependencies?.["undici-types"], UNDICI_TYPES_VERSION);
  if (checkNodeTypes) expectValue(path, "devDependencies.@types/node", metadata.devDependencies?.["@types/node"], NODE_TYPES_VERSION);
  if (checkOverride) expectValue(path, "overrides.undici-types", metadata.overrides?.["undici-types"], UNDICI_TYPES_VERSION);
}

for (const path of packageFiles) {
  const metadata = await readJson(path);
  checkPackageMetadata(path, metadata, {
    checkUndici: path !== "package.json",
    checkNodeTypes: path === "server/package.json",
    checkOverride: path === "server/package.json",
  });
}

for (const path of lockFiles) {
  const lock = await readJson(path);
  if (!lock) continue;

  const root = lock.packages?.[""];
  if (!root || typeof root !== "object") {
    failures.push(`${path}: packages[""] root entry is required`);
    continue;
  }

  expectValue(path, "packages[\"\"].engines.node", root.engines?.node, NODE_ENGINE);
  expectValue(path, "packages[\"\"].devDependencies.undici-types", root.devDependencies?.["undici-types"], UNDICI_TYPES_VERSION);
  const installedUndici = lock.packages?.["node_modules/undici-types"];
  expectValue(path, "packages.node_modules/undici-types.version", installedUndici?.version, UNDICI_TYPES_VERSION);

  if (path === "server/package-lock.json") {
    expectValue(path, "packages[\"\"].devDependencies.@types/node", root.devDependencies?.["@types/node"], NODE_TYPES_VERSION);
    expectValue(path, "packages.node_modules/@types/node.version", lock.packages?.["node_modules/@types/node"]?.version, NODE_TYPES_VERSION);
  }
}

const dockerfile = await readText("server/Dockerfile");
const nodeImages = [...dockerfile.matchAll(/^\s*FROM\s+node:([^\s]+)(?:\s+AS\s+[^\s]+)?\s*$/gim)].map((match) => match[1]);
if (nodeImages.length === 0) {
  failures.push("server/Dockerfile: no Node.js base image was found");
} else {
  for (const imageTag of nodeImages) {
    if (imageTag !== NODE_IMAGE) {
      failures.push(`server/Dockerfile: every Node.js base image must use node:${NODE_IMAGE}; found node:${imageTag}`);
    }
  }
}

for (const path of workflowFiles) {
  const source = await readText(path);
  const versions = [];
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*node-version:\s*([^\s#]+)\s*(?:#.*)?$/);
    if (!match) continue;
    versions.push(match[1].replace(/^(["'])(.*)\1$/, "$2"));
  }
  if (versions.length === 0) {
    failures.push(`${path}: at least one node-version entry is required`);
    continue;
  }
  for (const version of versions) {
    if (version !== NODE_VERSION) {
      failures.push(`${path}: every node-version entry must be ${NODE_VERSION}; found ${version}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Runtime, Node.js, undici-types and workflow version checks passed.");
}

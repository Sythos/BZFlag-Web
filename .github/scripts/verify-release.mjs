/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Sythos (https://www.sythos.net)
 *
 * Release-only validation. This deliberately uses Node.js built-ins so a tag
 * cannot bypass the project gates by omitting application dependencies.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = process.cwd();
const failures = [];

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function requireValue(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function git(args) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout.trim();
}

async function readText(path) {
  try {
    return await readFile(resolve(repositoryRoot, path), "utf8");
  } catch (error) {
    failures.push(`${path}: cannot read file (${error.code || error.message})`);
    return "";
  }
}

async function requireFile(path, label = path) {
  try {
    const info = await stat(resolve(repositoryRoot, path));
    if (!info.isFile() || info.size === 0) failures.push(`${label}: file is empty or not a regular file`);
  } catch (error) {
    failures.push(`${label}: missing (${error.code || error.message})`);
  }
}

async function requireDirectory(path, label = path) {
  try {
    if (!(await stat(resolve(repositoryRoot, path))).isDirectory()) failures.push(`${label}: not a directory`);
  } catch (error) {
    failures.push(`${label}: missing (${error.code || error.message})`);
  }
}

async function containsTypeScript(directory) {
  const entries = await readdir(resolve(repositoryRoot, directory), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory() && await containsTypeScript(path)) return true;
    if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) return true;
  }
  return false;
}

function requireMarker(source, path, marker) {
  if (!source.includes(marker)) failures.push(`${path}: missing required marker ${marker}`);
}

function resolveLocalReference(baseDirectory, reference, label) {
  if (!reference.startsWith("./")) return;
  const withoutQuery = reference.split(/[?#]/, 1)[0];
  const target = resolve(baseDirectory, withoutQuery);
  const outside = relative(repositoryRoot, target);
  if (outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside)) {
    failures.push(`${label}: reference escapes the repository: ${reference}`);
    return;
  }
  return requireFile(relative(repositoryRoot, target), `${label} -> ${reference}`);
}

const releaseTag = requireValue(option("--tag") || process.env.RELEASE_TAG, "A release tag is required");
const baseRef = option("--base-ref") || "origin/main";
const semverPattern = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
if (!semverPattern.test(releaseTag)) failures.push(`release tag is not strict vMAJOR.MINOR.PATCH SemVer: ${releaseTag}`);

const rootPackageText = await readText("package.json");
let rootPackage = null;
try {
  rootPackage = JSON.parse(rootPackageText);
} catch {
  failures.push("package.json: invalid JSON");
}

const serverPackageText = await readText("server/package.json");
let serverPackage = null;
try {
  serverPackage = JSON.parse(serverPackageText);
} catch {
  failures.push("server/package.json: invalid JSON");
}

if (rootPackage && rootPackage.version !== releaseTag.slice(1)) {
  failures.push(`package.json: version ${rootPackage.version} does not match ${releaseTag.slice(1)}`);
}
if (serverPackage && serverPackage.version !== releaseTag.slice(1)) {
  failures.push(`server/package.json: version ${serverPackage.version} does not match ${releaseTag.slice(1)}`);
}

const upstream = rootPackage?.["x-upstream"];
if (!upstream || typeof upstream !== "object") {
  failures.push("package.json: x-upstream provenance object is required");
} else {
  if (upstream.project !== "BZFlag") failures.push("package.json: x-upstream.project must be BZFlag");
  if (upstream.repository !== "https://github.com/BZFlag-Dev/bzflag") {
    failures.push("package.json: x-upstream.repository must point to BZFlag-Dev/bzflag");
  }
  if (!/^[0-9a-f]{40}$/i.test(String(upstream.ref || ""))) {
    failures.push("package.json: x-upstream.ref must be a full 40-character commit SHA");
  }
  if (!String(upstream.version || "").trim()) failures.push("package.json: x-upstream.version is required");
  if (!String(upstream.branch || "").trim()) failures.push("package.json: x-upstream.branch is required");
}

try {
  const head = git(["rev-parse", "--verify", "HEAD"]);
  const tagCommit = git(["rev-parse", "--verify", `${releaseTag}^{commit}`]);
  if (head !== tagCommit) failures.push(`checked-out HEAD ${head} does not match ${releaseTag} commit ${tagCommit}`);
  const tagType = git(["cat-file", "-t", `refs/tags/${releaseTag}`]);
  if (tagType !== "tag") failures.push(`${releaseTag}: release tag must be annotated`);
  const baseCommit = git(["rev-parse", "--verify", `${baseRef}^{commit}`]);
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", tagCommit, baseCommit], {
    cwd: repositoryRoot,
    stdio: "ignore",
  });
  if (ancestry.status !== 0) failures.push(`${releaseTag}: tag is not an ancestor of ${baseRef}`);
} catch (error) {
  failures.push(`git provenance check failed: ${error.message}`);
}

const requiredRootFiles = [
  "COPYING",
  "COPYING.LGPL",
  "COPYING.MPL",
  "LICENSE-MIT",
  "NOTICE",
  "ATTRIBUTION.md",
  "AUTHORS",
];
for (const path of requiredRootFiles) await requireFile(path);

const requiredReleaseFiles = [
  "client/index.html",
  "client/web_game_run.html",
  "client/manifest.webmanifest",
  "client/service-worker.ts",
  "client/package.json",
  "client/package-lock.json",
  "client/dist/app.js",
  "client/dist/game.js",
  "client/dist/i18n.js",
  "client/dist/protocol.js",
  "client/dist/renderer.js",
  "client/dist/service-worker.js",
  "server/index.html",
  "server/gateway.ts",
  "server/package.json",
  "server/package-lock.json",
  "server/dist/gateway.js",
  "server/LICENSE-MIT",
  "server/Dockerfile",
];
for (const path of requiredReleaseFiles) await requireFile(path);
await requireDirectory("client/dist", "client/dist build output");
await requireDirectory("server/dist", "server/dist build output");

for (const [directory, initialPackageData] of [["client", null], ["server", serverPackage]]) {
  let packageData = initialPackageData;
  if (!packageData && directory === "client") {
    try {
      packageData = JSON.parse(await readFile(resolve(repositoryRoot, "client/package.json"), "utf8"));
    } catch {
      continue;
    }
  }
  const scripts = packageData?.scripts || {};
  for (const script of ["build", "lint", "typecheck", "test"]) {
    if (typeof scripts[script] !== "string" || scripts[script].trim() === "") {
      failures.push(`${directory}/package.json: required ${script} script is missing`);
    }
  }
  try {
    if (!await containsTypeScript(directory)) failures.push(`${directory}: no TypeScript source file found`);
  } catch (error) {
    failures.push(`${directory}: cannot inspect TypeScript sources (${error.message})`);
  }
}

const licenseText = await readText("LICENSE-MIT");
for (const marker of [
  "Copyright (c) 2026 Sythos (https://www.sythos.net)",
  "Permission is hereby granted, free of charge",
  "THE SOFTWARE IS PROVIDED \"AS IS\"",
]) requireMarker(licenseText, "LICENSE-MIT", marker);

const dockerfileText = await readText("server/Dockerfile");
requireMarker(dockerfileText, "server/Dockerfile", "gateway.ts");
requireMarker(dockerfileText, "server/Dockerfile", "dist/gateway.js");
if (dockerfileText.includes("gateway.mjs")) {
  failures.push("server/Dockerfile: legacy gateway.mjs entrypoint is incompatible with the TypeScript build");
}

if (upstream?.ref) {
  for (const path of ["NOTICE", "ATTRIBUTION.md", "client/assets/upstream/README.md", "client/manifest.webmanifest"]) {
    requireMarker(await readText(path), path, String(upstream.ref));
  }
}

const htmlFiles = ["client/index.html", "client/web_game_run.html", "server/index.html"];
for (const path of htmlFiles) {
  const source = await readText(path);
  const baseDirectory = resolve(repositoryRoot, dirname(path));
  for (const match of source.matchAll(/(?:src|href)=["'](\.[/][^"'?#]*)/gi)) {
    await resolveLocalReference(baseDirectory, match[1], path);
  }
}

const manifestText = await readText("client/manifest.webmanifest");
try {
  const manifest = JSON.parse(manifestText);
  const baseDirectory = resolve(repositoryRoot, "client");
  for (const icon of manifest.icons || []) {
    if (typeof icon.src === "string") await resolveLocalReference(baseDirectory, icon.src, "client/manifest.webmanifest");
  }
} catch {
  failures.push("client/manifest.webmanifest: invalid JSON");
}

const serviceWorker = await readText("client/service-worker.ts");
const serviceWorkerBase = resolve(repositoryRoot, "client");
for (const match of serviceWorker.matchAll(/["'](\.[/][^"']+)["']/g)) {
  await resolveLocalReference(serviceWorkerBase, match[1], "client/service-worker.ts");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Release ${releaseTag} metadata, provenance, licenses and local asset references are valid.`);
}

/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Sythos (https://www.sythos.net)
 *
 * Release gate for the pinned toolchain. Exact versions are intentionally
 * reproducible; --check-latest also compares them with the current stable
 * upstream releases and accepts a pin only because the rationale below is
 * explicit and reviewable.
 */

import { readFile } from "node:fs/promises";

const NODE_VERSION = "26.7.0";
const NODE_IMAGE = `${NODE_VERSION}-alpine`;
const TYPESCRIPT_VERSION = "7.0.2";
const UNDICI_TYPES_VERSION = "8.10.0";
const NODE_TYPES_VERSION = "26.2.0";
const PLAYWRIGHT_VERSION = "1.62.1";
const ACTIONLINT_VERSION = "1.7.7";
const ZIZMOR_VERSION = "1.11.0";

const PIN_REASONS = {
  node: "Node 26.7.0 is pinned for reproducible CI/Docker parity; setup-node still checks the stable 26 line.",
  typescript: "TypeScript is pinned with both package locks so compiler changes cannot silently alter release output.",
  undici: "undici-types is pinned to the Node 26 declaration surface used by both packages.",
  nodeTypes: "@types/node is pinned to the Node 26 declaration surface used by the gateway.",
  playwright: "Playwright is pinned to the browser revision validated by the checked-in Connect-to-game E2E.",
  actionlint: "actionlint is pinned for deterministic workflow linting; upgrades require a separate gate review.",
  zizmor: "zizmor is pinned for deterministic workflow security auditing; upgrades require a separate gate review.",
  actions: "GitHub Actions are pinned to immutable commit SHAs; the inline stable release comment is audited for drift.",
};

const packageFiles = ["client/package.json", "server/package.json"];
const lockFiles = ["client/package-lock.json", "server/package-lock.json"];
const workflowFiles = [
  ".github/workflows/ci.yml",
  ".github/workflows/compliance.yml",
  ".github/workflows/container.yml",
  ".github/workflows/release.yml",
  ".github/workflows/security.yml",
  ".github/workflows/workflow-lint.yml",
];
const failures = [];
const latestMessages = [];

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    failures.push(`${path}: cannot read file (${error.code || error.message})`);
    return "";
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    failures.push(`${path}: invalid JSON (${error.message})`);
    return null;
  }
}

function expect(path, label, actual, expected) {
  if (actual !== expected) failures.push(`${path}: ${label} must be ${expected}; found ${actual ?? "<missing>"}`);
}

function expectText(source, path, marker) {
  if (!source.includes(marker)) failures.push(`${path}: missing ${marker}`);
}

for (const path of packageFiles) {
  const packageData = await readJson(path);
  if (!packageData) continue;
  expect(path, "engines.node", packageData.engines?.node, `>=${NODE_VERSION}`);
  expect(path, "devDependencies.typescript", packageData.devDependencies?.typescript, TYPESCRIPT_VERSION);
  expect(path, "devDependencies.undici-types", packageData.devDependencies?.["undici-types"], UNDICI_TYPES_VERSION);
  if (path === "server/package.json") {
    expect(path, "devDependencies.@types/node", packageData.devDependencies?.["@types/node"], NODE_TYPES_VERSION);
    expect(path, "overrides.undici-types", packageData.overrides?.["undici-types"], UNDICI_TYPES_VERSION);
  }
}

for (const path of lockFiles) {
  const lock = await readJson(path);
  if (!lock) continue;
  expect(path, "packages[\"\"].engines.node", lock.packages?.[""].engines?.node, `>=${NODE_VERSION}`);
  expect(path, "packages[\"\"].devDependencies.typescript", lock.packages?.[""].devDependencies?.typescript, TYPESCRIPT_VERSION);
  expect(path, "packages[\"\"].devDependencies.undici-types", lock.packages?.[""].devDependencies?.["undici-types"], UNDICI_TYPES_VERSION);
  expect(path, "node_modules/typescript.version", lock.packages?.["node_modules/typescript"]?.version, TYPESCRIPT_VERSION);
  expect(path, "node_modules/undici-types.version", lock.packages?.["node_modules/undici-types"]?.version, UNDICI_TYPES_VERSION);
  if (path === "server/package-lock.json") {
    expect(path, "packages[\"\"].devDependencies.@types/node", lock.packages?.[""].devDependencies?.["@types/node"], NODE_TYPES_VERSION);
    expect(path, "node_modules/@types/node.version", lock.packages?.["node_modules/@types/node"]?.version, NODE_TYPES_VERSION);
  }
}

const dockerfile = await readText("server/Dockerfile");
if (dockerfile && !new RegExp(`FROM\\s+node:${NODE_IMAGE}\\b`, "i").test(dockerfile)) {
  failures.push(`server/Dockerfile: Node image must be node:${NODE_IMAGE}`);
}

const workflows = new Map();
for (const path of workflowFiles) workflows.set(path, await readText(path));
const actionReferences = new Map();
for (const [path, source] of workflows) {
  const nodeVersions = [...source.matchAll(/^\s*node-version:\s*["']?([^\s"'#]+)["']?/gim)].map((match) => match[1]);
  if (nodeVersions.length === 0 && /(?:setup-node|npm\s|node\s+\.github)/.test(source)) failures.push(`${path}: node-version is required`);
  for (const version of nodeVersions) if (version !== NODE_VERSION) failures.push(`${path}: node-version must be ${NODE_VERSION}; found ${version}`);
  if (source.includes("playwright@") && !source.includes(`playwright@${PLAYWRIGHT_VERSION}`)) {
    failures.push(`${path}: Playwright must remain pinned to ${PLAYWRIGHT_VERSION}`);
  }
  for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)\s+#\s*(v[^\s;]+)(?:\s*;.*)?$/gim)) {
    const reference = match[1];
    const releaseComment = match[2];
    if (!/@[0-9a-f]{40}$/i.test(reference)) failures.push(`${path}: action must use a full commit SHA: ${reference}`);
    const action = reference.slice(0, reference.lastIndexOf("@"));
    if (!/^https?:\/\//.test(action)) {
      if (!actionReferences.has(action)) actionReferences.set(action, { releaseComment, paths: [] });
      actionReferences.get(action).paths.push(path);
    }
  }
  if (source.includes("go install github.com/rhysd/actionlint/cmd/actionlint@")) expectText(source, path, `actionlint@v${ACTIONLINT_VERSION}`);
  if (source.includes("zizmor==")) expectText(source, path, `zizmor==${ZIZMOR_VERSION}`);
}

async function fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const authorization = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "bzflag-web-toolchain-gate", ...authorization, ...headers },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function compareLatest(label, pinned, reason, url, extract) {
  try {
    const latest = extract(await fetchJson(url));
    if (!latest) throw new Error("stable version not found");
    if (latest === pinned) {
      latestMessages.push(`${label}: ${pinned} is current stable`);
    } else if (reason) {
      latestMessages.push(`${label}: ${pinned} pinned; upstream stable is ${latest} (${reason})`);
    } else {
      failures.push(`${label}: pinned ${pinned} differs from stable ${latest} and has no documented pin rationale`);
    }
  } catch (error) {
    failures.push(`${label}: latest stable check failed (${error.message})`);
  }
}

if (process.argv.includes("--check-latest")) {
  await compareLatest("Node.js", NODE_VERSION, PIN_REASONS.node, "https://nodejs.org/dist/index.json", (releases) => {
    const stable = releases.find((entry) => entry.lts && !entry.version.includes("-") && entry.version.startsWith("v26."))
      || releases.find((entry) => !entry.version.includes("-") && entry.version.startsWith("v26."));
    return stable?.version?.slice(1);
  });
  for (const [label, version, reason, packageName] of [
    ["TypeScript", TYPESCRIPT_VERSION, PIN_REASONS.typescript, "typescript"],
    ["undici-types", UNDICI_TYPES_VERSION, PIN_REASONS.undici, "undici-types"],
    ["@types/node", NODE_TYPES_VERSION, PIN_REASONS.nodeTypes, "@types/node"],
    ["Playwright", PLAYWRIGHT_VERSION, PIN_REASONS.playwright, "playwright"],
  ]) {
    await compareLatest(label, version, reason, `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, (metadata) => metadata.version);
  }
  for (const [action, record] of actionReferences) {
    await compareLatest(`Action ${action}`, record.releaseComment, PIN_REASONS.actions, `https://api.github.com/repos/${action}/releases/latest`, (release) => String(release.tag_name || ""));
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Toolchain pins passed (Node ${NODE_VERSION}, TypeScript ${TYPESCRIPT_VERSION}, Playwright ${PLAYWRIGHT_VERSION}, immutable actions).`);
  for (const message of latestMessages) console.log(message);
}

/*
 * SPDX-License-Identifier: MIT
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
 * Structural release gate for the client protocol/world/game/renderer/PWA
 * surface and the standalone gateway package. The application tests remain the
 * behavioural source of truth; this check makes their presence and execution
 * path non-optional in CI and release packaging.
 */

import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = process.cwd();
const failures = [];

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
    if (!info.isFile() || info.size === 0) failures.push(`${label}: missing or empty`);
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

function requireMarker(source, path, marker) {
  if (!source.includes(marker)) failures.push(`${path}: missing required gate marker ${marker}`);
}

function parseJson(source, path) {
  try {
    return JSON.parse(source);
  } catch (error) {
    failures.push(`${path}: invalid JSON (${error.message})`);
    return null;
  }
}

const clientSources = [
  "client/protocol.ts",
  "client/world.ts",
  "client/game.ts",
  "client/renderer.ts",
  "client/state.ts",
  "client/service-worker.ts",
];
for (const path of clientSources) await requireFile(path, `${path} source`);

const clientTests = [
  ["client/tests/protocol.test.mjs", /protocol|packet|handshake/i],
  ["client/tests/world.test.mjs", /world|transfer|envelope/i],
  ["client/tests/game.test.mjs", /game|gateway|websocket/i],
  ["client/tests/renderer.test.mjs", /renderer|webgpu|webgl|geometry/i],
  ["client/tests/state.test.mjs", /state|snapshot|player/i],
  ["client/tests/service-worker.test.mjs", /service.?worker|cache|manifest/i],
  ["client/tests/i18n.test.mjs", /locale|translation|catalog/i],
  ["client/tests/smoke.mjs", /protocol\.test|world\.test|game\.test|renderer\.test|state\.test|service-worker\.test/i],
];
const clientTestSources = new Map();
for (const [path, pattern] of clientTests) {
  const source = await readText(path);
  clientTestSources.set(path, source);
  if (source && !pattern.test(source)) failures.push(`${path}: does not exercise its required functional gate`);
}

const smoke = clientTestSources.get("client/tests/smoke.mjs") || "";
for (const testName of [
  "protocol.test.mjs",
  "world.test.mjs",
  "game.test.mjs",
  "renderer.test.mjs",
  "state.test.mjs",
  "service-worker.test.mjs",
  "i18n.test.mjs",
]) {
  if (!smoke.includes(`./${testName}`)) {
    failures.push(`client/tests/smoke.mjs: ${testName} is not part of the mandatory smoke path`);
  }
}

const clientPackage = parseJson(await readText("client/package.json"), "client/package.json");
if (clientPackage) {
  for (const script of ["build", "lint", "typecheck", "test"]) {
    if (typeof clientPackage.scripts?.[script] !== "string" || clientPackage.scripts[script].trim() === "") {
      failures.push(`client/package.json: required ${script} script is missing`);
    }
  }
  if (!clientPackage.scripts.test.includes("tests/smoke.mjs")) {
    failures.push("client/package.json: test script must execute tests/smoke.mjs");
  }
}

const serverPackage = parseJson(await readText("server/package.json"), "server/package.json");
if (serverPackage) {
  for (const script of ["build", "lint", "typecheck", "test"]) {
    if (typeof serverPackage.scripts?.[script] !== "string" || serverPackage.scripts[script].trim() === "") {
      failures.push(`server/package.json: required ${script} script is missing`);
    }
  }
  if (!serverPackage.scripts.test.includes("gateway.test")) {
    failures.push("server/package.json: test script must execute gateway.test");
  }
}

await requireFile(".github/scripts/verify-bzfs-interoperability.mjs", "BZFS interoperability smoke script");

const smokeSource = clientTestSources.get("client/tests/smoke.mjs") || "";
for (const marker of [
  '"dist/protocol.js"',
  '"dist/world.js"',
  '"dist/game.js"',
  '"dist/renderer.js"',
  '"dist/service-worker.js"',
]) requireMarker(smokeSource, "client/tests/smoke.mjs", marker);

const serviceWorker = await readText("client/service-worker.ts");
requireMarker(serviceWorker, "client/service-worker.ts", "const ASSET_MANIFEST");
requireMarker(serviceWorker, "client/service-worker.ts", "const STATIC_ASSETS");

const manifestSource = await readText("client/manifest.webmanifest");
const manifest = parseJson(manifestSource, "client/manifest.webmanifest");
if (manifest) {
  if (manifest.scope !== "./") failures.push("client/manifest.webmanifest: scope must remain ./");
  if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) failures.push("client/manifest.webmanifest: icons are required");
}

for (const path of [
  "client/index.html",
  "client/web_game_run.html",
  "client/manifest.webmanifest",
  "client/service-worker.js",
  "client/dist/app.js",
  "client/dist/game.js",
  "client/dist/i18n.js",
  "client/dist/protocol.js",
  "client/dist/renderer.js",
  "client/dist/state.js",
  "client/dist/world.js",
  "client/dist/service-worker.js",
]) await requireFile(path);
await requireDirectory("client/dist", "client/dist build output");

const gameHtml = await readText("client/web_game_run.html");
for (const marker of ["game-canvas", "dist/protocol.js", "dist/renderer.js", "dist/game.js", "chat-composer"]) {
  requireMarker(gameHtml, "client/web_game_run.html", marker);
}
const gameSource = await readText("client/game.ts");
requireMarker(gameSource, "client/game.ts", "./dist/world.js");
requireMarker(gameSource, "client/game.ts", "./dist/state.js");
const indexHtml = await readText("client/index.html");
for (const marker of ["connect-form", "manifest.webmanifest", "dist/app.js", "session-token"]) {
  requireMarker(indexHtml, "client/index.html", marker);
}

await requireFile("server/gateway.ts");
await requireFile("server/gateway.test.ts");
await requireFile("server/Dockerfile");
await requireFile("server/dist/gateway.js");
await requireFile("server/dist/gateway.test.js");
await requireFile("server/index.html");
await requireDirectory("server/dist", "server/dist build output");

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Protocol, world, game, renderer, state, PWA and gateway release gates are present and wired into the package tests.");
}

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
 */

import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const requiredFiles = [
  "index.html",
  "web_game_run.html",
  "styles.css",
  "i18n.ts",
  "app.ts",
  "renderer.ts",
  "protocol.ts",
  "state.ts",
  "world.ts",
  "game.ts",
  "service-worker.ts",
  "build.mjs",
  "dist/app.js",
  "dist/game.js",
  "dist/i18n.js",
  "dist/protocol.js",
  "dist/state.js",
  "dist/world.js",
  "dist/renderer.js",
  "dist/service-worker.js",
  "service-worker.js",
  "tests/protocol.test.mjs",
  "tests/renderer.test.mjs",
  "tests/state.test.mjs",
  "tests/world.test.mjs",
  "manifest.webmanifest",
  "assets/favicon.svg",
  "assets/social-card.svg",
  "assets/asset-manifest.json",
  "assets/branding/favicon.ico",
  "assets/branding/apple-touch-icon.png",
  "assets/branding/android-chrome-192x192.png",
  "assets/branding/android-chrome-512x512.png",
  "assets/branding/og-image.png",
  "assets/branding/social-card.png",
  "assets/upstream/fire.wav",
  "assets/upstream/explosion.wav",
  "assets/upstream/jump.wav",
  "assets/upstream/flag_grab.wav",
  "assets/upstream/l10n/bzflag_it.po",
  "assets/upstream/l10n/bzflag_en_US_l33t.po",
  "tests/i18n.test.mjs",
  "tests/service-worker.test.mjs"
];

for (const relativePath of requiredFiles) {
  await access(join(root, relativePath));
}

async function assertLocalReference(reference, sourceFile) {
  const cleanReference = reference.split("#", 1)[0].split("?", 1)[0];
  if (!cleanReference || cleanReference === "./" || !cleanReference.startsWith("./")) return;
  const target = join(root, cleanReference.slice(2));
  try {
    await stat(target);
  } catch {
    throw new Error(`${sourceFile} references missing local asset ${reference}`);
  }
}

const index = await readFile(join(root, "index.html"), "utf8");
const game = await readFile(join(root, "web_game_run.html"), "utf8");
const gameSource = await readFile(join(root, "game.ts"), "utf8");
const serviceWorker = await readFile(join(root, "service-worker.ts"), "utf8");
const manifest = JSON.parse(await readFile(join(root, "manifest.webmanifest"), "utf8"));
const assetManifest = JSON.parse(await readFile(join(root, "assets/asset-manifest.json"), "utf8"));

for (const [sourceFile, source] of [["index.html", index], ["web_game_run.html", game]]) {
  const references = [...source.matchAll(/(?:src|href|content)="(\.\/[^"#?]+(?:\?[^"#]*)?)"/g)];
  for (const [, reference] of references) await assertLocalReference(reference, sourceFile);
}
for (const reference of serviceWorker.matchAll(/"(\.\/[^"\n]+)"/g)) {
  await assertLocalReference(reference[1], "service-worker.ts");
}
for (const reference of gameSource.matchAll(/"(\.\/assets\/[^"\n]+)"/g)) {
  await assertLocalReference(reference[1], "game.ts");
}
for (const value of JSON.stringify(manifest).matchAll(/"(\.\/[^"\\]+)"/g)) {
  await assertLocalReference(value[1], "manifest.webmanifest");
}

if (!assetManifest._license?.includes("SPDX-License-Identifier: MIT") || assetManifest["relative-to"] !== "./") {
  throw new Error("asset-manifest.json is missing its MIT metadata or relative base");
}
if (!Array.isArray(assetManifest.entries) || assetManifest.entries.length === 0) {
  throw new Error("asset-manifest.json has no cache entries");
}
const assetEntryPaths = new Set();
for (const entry of assetManifest.entries) {
  if (!entry || typeof entry.path !== "string" || !entry.path.startsWith("./assets/") || entry.path.includes("://")) {
    throw new Error(`asset-manifest.json contains an invalid path: ${entry?.path}`);
  }
  if (assetEntryPaths.has(entry.path)) {
    throw new Error(`asset-manifest.json contains a duplicate path: ${entry.path}`);
  }
  assetEntryPaths.add(entry.path);
  await assertLocalReference(entry.path, "asset-manifest.json");
  if (entry.path.startsWith("./assets/upstream/") && entry.path !== "./assets/upstream/README.md" && entry.license === "MIT") {
    throw new Error(`upstream asset was incorrectly labelled MIT: ${entry.path}`);
  }
}

async function collectFiles(directory, prefix) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await collectFiles(path, relative));
    } else {
      files.push(relative.replaceAll("\\", "/"));
    }
  }
  return files;
}

for (const file of await collectFiles(join(root, "assets"), "assets")) {
  if (!assetEntryPaths.has(`./${file}`)) {
    throw new Error(`local asset is missing from asset-manifest.json: ${file}`);
  }
}

for (const marker of ["connect-form", "remember-password", "session-token", "F11", "BZFS 2.4.31", "Sythos"]) {
  if (!index.includes(marker)) throw new Error(`index.html is missing ${marker}`);
}
for (const marker of ["game-canvas", "protocol.js", "WebGPU", "WebGL2", "Sythos", "BZFS 2.4.31"]) {
  if (!game.includes(marker)) throw new Error(`web_game_run.html is missing ${marker}`);
}
if (manifest.license !== "MIT" || manifest.scope !== "./") {
  throw new Error("manifest.webmanifest has an unexpected license or scope");
}
if (!index.includes('id="gateway-endpoint"') || !index.includes('id="gateway-endpoint" name="gateway" type="text"')) {
  throw new Error("gateway endpoint must accept relative bridge paths");
}

await import("./protocol.test.mjs");
await import("./renderer.test.mjs");
await import("./state.test.mjs");
await import("./world.test.mjs");
await import("./i18n.test.mjs");
await import("./service-worker.test.mjs");

console.log(`Client smoke checks passed (${requiredFiles.length} required files).`);

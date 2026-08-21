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

import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = await readFile(join(root, "dist/service-worker.js"), "utf8");
const assetManifest = JSON.parse(await readFile(join(root, "assets/asset-manifest.json"), "utf8"));
const handlers = new Map();
const cache = {
  added: [],
  deleted: [],
  async addAll(urls) {
    this.added = [...urls];
  },
  async put() {}
};
const cachedIndex = { marker: "offline-index" };
const cachesApi = {
  async open() {
    return cache;
  },
  async keys() {
    return ["unrelated-cache", "bzflag-web-client-old", "bzflag-web-client-v0.1.2"];
  },
  async delete(key) {
    cache.deleted.push(key);
    return true;
  },
  async match(request) {
    return String(request).includes("index.html") ? cachedIndex : undefined;
  }
};
const self = {
  location: { origin: "https://example.test", href: "https://example.test/" },
  clients: { claim: async () => {} },
  skipWaiting: async () => {},
  addEventListener(type, listener) {
    handlers.set(type, listener);
  }
};
const Response = {
  error() {
    return { marker: "offline-error" };
  }
};
const context = {
  Response,
  URL,
  caches: cachesApi,
  fetch: async (url) => {
    if (String(url).includes("asset-manifest.json")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return assetManifest;
        }
      };
    }
    throw new Error("offline");
  },
  self
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "dist/service-worker.js" });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let installPromise;
handlers.get("install")({ waitUntil(promise) { installPromise = promise; } });
await installPromise;
const cached = new Set(cache.added);
for (const entry of assetManifest.entries) {
  assert(cached.has(entry.path), `offline install omitted ${entry.path}`);
}
assert(cached.has("./index.html"), "offline install omitted the connection shell");
for (const script of ["./dist/renderer.js", "./dist/state.js", "./dist/world.js", "./dist/service-worker.js"]) {
  assert(cached.has(script), `offline install omitted ${script}`);
}
assert([...cached].every((path) => path.startsWith("./")), "offline cache contains a non-relative path");

let activatePromise;
handlers.get("activate")({ waitUntil(promise) { activatePromise = promise; } });
await activatePromise;
assert(cache.deleted.includes("bzflag-web-client-old"), "activate did not remove the previous BZFlag cache");
assert(!cache.deleted.includes("unrelated-cache"), "activate removed an unrelated application cache");

let responsePromise;
handlers.get("fetch")({
  request: { method: "GET", url: "https://example.test/assets/upstream/fire.wav", mode: "same-origin" },
  respondWith(promise) { responsePromise = promise; },
  waitUntil() {}
});
assert((await responsePromise).marker === "offline-error", "offline asset request returned the HTML shell");

handlers.get("fetch")({
  request: { method: "GET", url: "https://example.test/game/unknown", mode: "navigate" },
  respondWith(promise) { responsePromise = promise; },
  waitUntil() {}
});
assert((await responsePromise).marker === "offline-index", "offline navigation did not return the cached shell");

console.log("Service-worker checks passed (manifest closure and offline fallbacks).");

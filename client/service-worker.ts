// @ts-nocheck
/*
Copyright (c) 2026 Sythos (https://www.sythos.net)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

const CACHE_NAME = "bzflag-web-client-v0.1.0";
const ASSET_MANIFEST = "./assets/asset-manifest.json";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./web_game_run.html",
  "./styles.css",
  "./service-worker.js",
  "./dist/i18n.js",
  "./dist/app.js",
  "./dist/renderer.js",
  "./dist/protocol.js",
  "./dist/game.js",
  "./dist/state.js",
  "./dist/service-worker.js",
  "./manifest.webmanifest",
  ASSET_MANIFEST
];

async function resolveAssetManifest() {
  const response = await fetch(ASSET_MANIFEST, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Asset manifest request failed with HTTP ${response.status}`);
  }
  const manifest = await response.json();
  if (!Array.isArray(manifest.entries)) {
    throw new Error("Asset manifest does not contain an entries array");
  }
  const assetPaths = manifest.entries.map((entry) => entry?.path);
  if (assetPaths.some((path) => typeof path !== "string" || !path.startsWith("./") || path.includes("://"))) {
    throw new Error("Asset manifest contains an absolute or invalid path");
  }
  return [...new Set([...STATIC_ASSETS, ...assetPaths])];
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(await resolveAssetManifest());
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) {
      return cached;
    }
    try {
      const response = await fetch(request);
      if (response && response.status === 200 && response.type === "basic") {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
      }
      return response;
    } catch {
      if (request.mode === "navigate") {
        return (await caches.match("./index.html")) || Response.error();
      }
      return Response.error();
    }
  })());
});

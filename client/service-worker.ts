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

const CACHE_NAME = "bzflag-web-client-v0.1.2";
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
  "./dist/world.js",
  "./dist/game.js",
  "./dist/state.js",
  "./dist/service-worker.js",
  "./manifest.webmanifest",
  ASSET_MANIFEST
] as const;

type AssetManifest = { entries: Array<{ path: string }> };
type ServiceWorkerEvent = Event & { waitUntil(promise: Promise<unknown>): void };
type ServiceWorkerFetchEvent = ServiceWorkerEvent & {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
};
type ServiceWorkerScope = {
  location: Location;
  clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: string, listener: (event: ServiceWorkerEvent | ServiceWorkerFetchEvent) => void): void;
};

const serviceWorkerScope = self as unknown as ServiceWorkerScope;

function isScopedRelativeAsset(path: unknown): path is string {
  if (typeof path !== "string" || !path.startsWith("./") || path.includes("\\") || path.includes("://")) return false;
  const scope = new URL("./", serviceWorkerScope.location.href);
  const target = new URL(path, serviceWorkerScope.location.href);
  return target.origin === scope.origin && target.pathname.startsWith(scope.pathname) && !path.split("/").includes("..");
}

async function resolveAssetManifest(): Promise<string[]> {
  const response = await fetch(ASSET_MANIFEST, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Asset manifest request failed with HTTP ${response.status}`);
  }
  const manifest = await response.json() as Partial<AssetManifest>;
  if (!Array.isArray(manifest.entries)) {
    throw new Error("Asset manifest does not contain an entries array");
  }
  const assetPaths = manifest.entries.map((entry) => entry.path);
  if (assetPaths.some((path) => !isScopedRelativeAsset(path))) {
    throw new Error("Asset manifest contains an absolute or invalid path");
  }
  return [...new Set([...STATIC_ASSETS, ...assetPaths])];
}

serviceWorkerScope.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(await resolveAssetManifest());
    await serviceWorkerScope.skipWaiting();
  })());
});

serviceWorkerScope.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => serviceWorkerScope.clients.claim())
  );
});

serviceWorkerScope.addEventListener("fetch", (event) => {
  const fetchEvent = event as ServiceWorkerFetchEvent;
  const request = fetchEvent.request;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== serviceWorkerScope.location.origin) {
    return;
  }
  fetchEvent.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) {
      return cached;
    }
    try {
      const response = await fetch(request);
      if (response && response.status === 200 && response.type === "basic") {
        const copy = response.clone();
        fetchEvent.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
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

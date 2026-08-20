<!--
SPDX-License-Identifier: MIT
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
-->

=> BZFlag Web Client

This directory is a static HTML5 client package whose TypeScript source compiles
to browser-ready JavaScript. It contains the connection page (`index.html`), the
independent game window (`web_game_run.html`), WebGPU rendering with a WebGL2
fallback, binary BZFlag bridge framing, a PWA service worker, local upstream
media and the sixteen locale catalogues from the pinned BZFlag 2.4.31 baseline.

Version `0.1.2` is an MVP/prototype, not a complete playable BZFlag client. It
currently wires the connection form, session handoff, initial keyboard and audio
controls, renderer selection, bounded bridge framing and a deterministic scene
pipeline for validated world geometry, tanks, shots and flags. Complete world
simulation, native protocol/gameplay parity, full asset integration and verified
official-server interoperability remain milestones. This document describes the
current boundary and must not be read as a production compatibility claim.

The package is not a native BZFlag executable and does not include `bzfs`. A
Node.js gateway in [`../server/`](../server/) is required because a browser page
cannot open native BZFlag TCP or UDP sockets. The gateway must use an allowlist
entry such as `official-main`; arbitrary hosts and custom servers are rejected by
the default policy.

==> Local installation

Serve this directory from a static HTTP server. `localhost` is suitable for
development; HTTPS is required for WebGPU and service-worker/PWA behaviour on a
deployed origin.

The build toolchain requires Node.js 26.7.0 (or a newer supported stable
release) and npm. The exact runtime and lockfile versions are checked by CI.

Run these commands from `client/`:

```sh
npm ci
npm run build
npx --yes serve . -l 4173
```

Open `http://127.0.0.1:4173/index.html`, enter the server identifier configured
in the gateway, the gateway endpoint (normally `/bridge`) and the short-lived
gateway session token supplied by the operator. Select **Connect** to open
`web_game_run.html`. The setup page also includes a browser fullscreen button and
recommends `F11`.

The gateway token is kept only in the current tab's `sessionStorage`. The BZFlag
server password is never saved unless the player explicitly enables **Save
password on this device**; when disabled, it is removed from local preferences.
The client does not log credentials or send them to analytics.

==> Apache deployment

Point the virtual host or an `Alias` at this directory. The included
[`deploy/apache.conf`](deploy/apache.conf) enables the manifest and service
worker MIME behaviour and keeps versioned assets cacheable. Enable HTTPS before
advertising the PWA or WebGPU path.

==> Nginx deployment

Use [`deploy/nginx.conf`](deploy/nginx.conf) inside the relevant `server` block,
or copy its `location` directives into an existing site. Keep the static client
and Node.js gateway on a known origin, or list the exact client origin in the
gateway's `allowedOrigins` array. When the gateway uses another origin, use
`wss://` and configure the reverse proxy for WebSocket upgrades.

==> Browser rendering and media

=> WebGPU is preferred when `navigator.gpu` and a usable adapter are available.
=> WebGL2 is selected automatically when WebGPU is unavailable.
=> Current Chromium, Gecko and WebKit-based browsers are supported as far as
   their secure-context and GPU capabilities allow.
=> TypeScript 7.0.2 is the client source of truth; `dist/` contains the emitted
   browser JavaScript used by the static pages.
=> Audio starts after the user's Connect gesture and can be muted in the game
   window. HTML5 media assets remain local whenever their licenses permit.
=> The service worker caches the shell and local assets, but an offline cache
   cannot make an online BZFlag session playable without a network connection.

WebGPU is the modern high-throughput path for buffers, pipelines and effect
geometry. WebGL2 is the practical compatibility path for browsers that do not
yet expose a usable WebGPU adapter. Both paths are designed to share the same
scene data, input layer, asset pipeline and gateway session. WebAssembly may be
added for isolated routines only when measurement shows a meaningful benefit.

==> World geometry boundary

The renderer consumes the bounded `worldGeometry` snapshot produced by the
state layer. Boxes, walls, pyramids, bases, teleporters, spheres, cones, arcs,
meshes and zones are normalized into safe browser scene objects; tank bodies,
turrets, tracks, barrels, shots, flag poles and flag cloth are rendered from the
same authoritative entity snapshot. This is a real scene-data path, not a
claim that every native BZFlag obstacle is already decoded.

The compressed BZFlag world database is not self-describing at the individual
object level. Its dynamic-colour, material, transform, obstacle, link, weapon
and entry-zone managers must be decoded in native order. `world.ts` therefore
validates the native envelope and exposes a strict adapter for a future native
or WebAssembly decoder; until that decoder is supplied, the client keeps the
safe world summary and does not invent geometry from compressed bytes.

The input layer keeps the native keyboard mapping as its intended compatibility
source of truth. The MVP includes the initial controls and the F11 guidance;
complete native command coverage, pointer lock and touch/gamepad extensions are
follow-up work. Browser audio starts from a user gesture to comply with the
autoplay policy.

==> PWA, cache and localization

The application shell is installable as a PWA. A versioned service worker is
copied to the client root during the TypeScript build so that Apache and Nginx
can grant it the normal site-wide scope. Cache entries are namespaced by web
package version, and `localStorage` is reserved for non-sensitive preferences
and the explicit password-persistence choice. Deployments that prohibit password
storage can disable that option in their configuration.

The localization layer follows the sixteen locale catalogues present in the
pinned upstream baseline: `cs_CZ`, `da`, `de`, `en_US_l33t`, `en_US_redneck`,
`es`, `fr`, `it`, `kg`, `lt`, `nl`, `pt`, `ru`, `sk`, `sv` and `xx`. Translation
keys and locale data remain separate from renderer and network code.

==> Upstream assets and licensing

`assets/upstream/` is a publishable asset-only subset copied from upstream BZFlag
revision `59b3ef44fa4538296be8b7f5eeafc2a4e57d0b74`. It contains runtime
textures, WAV effects, font bitmaps and locale catalogues. These files retain
their upstream notices and are not relicensed as MIT. Read the local asset
manifest [`assets/upstream/README.md`](assets/upstream/README.md),
[`../NOTICE`](../NOTICE), [`../ATTRIBUTION.md`](../ATTRIBUTION.md) and the
preserved [`../COPYING*`](../COPYING) files before redistribution.

==> Development checks

The TypeScript files are the source of truth. The build emits browser-ready
JavaScript in `dist/` and copies the compiled service worker to the client root
so Apache and Nginx can provide its normal scope.

```sh
npm run check
npm test
```

The client smoke tests validate the local asset and HTML closure. Gateway tests
use local TCP and UDP fixtures only. A real official-server interoperability
test requires an operator-provided allowlist and credentials; CI never scans or
contacts public BZFlag servers.

==> Credits and license

The original browser code and client packaging are MIT-licensed by Sythos
([https://www.sythos.net](https://www.sythos.net)). Upstream BZFlag assets and
catalogues remain under their original LGPL-2.1/MPL-2.0 terms. The complete
project-level notices are in [`../LICENSE-MIT`](../LICENSE-MIT),
[`../COPYING.LGPL`](../COPYING.LGPL), [`../COPYING.MPL`](../COPYING.MPL),
[`../NOTICE`](../NOTICE), [`../AUTHORS`](../AUTHORS) and
[`../ATTRIBUTION.md`](../ATTRIBUTION.md). Visible pages identify the
compatibility reference as `[BZFS 2.4.31]` and show the Sythos credit.

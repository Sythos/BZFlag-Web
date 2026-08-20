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

# BZFlag Web Client

This directory is a static HTML5 client MVP/prototype package. It contains the
connection screen (`index.html`), the independent game window
(`web_game_run.html`), a WebGPU capability/rendering preview with a WebGL2
fallback, binary BZFlag bridge framing, the PWA service worker, local upstream
media and all sixteen locale catalogues from the pinned BZFlag 2.4.31 baseline.

The current `0.1.0` client is not yet a full playable BZFlag implementation.
It wires the connection form, session handoff, initial keyboard/audio controls,
renderer selection and bounded bridge session. Complete world simulation,
native protocol/gameplay parity, full asset/media integration and verified
official-server interoperability remain milestones. This README documents the
current prototype boundary and must not be read as a production compatibility
claim.

The package is not a native BZFlag executable and does not include `bzfs`. A
Node.js gateway in `../server/` is required for a browser session because web
pages cannot open the native BZFlag TCP/UDP sockets. The gateway must be
configured with an allowlist entry such as `official-main`; arbitrary hosts
and custom servers are rejected by its default policy.

## Local installation

Serve this directory from a static HTTP server. `localhost` is suitable for
development; HTTPS is required for WebGPU and service-worker/PWA behaviour on
deployed origins.

```sh
npm ci
npm run build
npx --yes serve . -l 4173
```

Open `http://127.0.0.1:4173/index.html`, enter the server id configured in the
gateway, the gateway endpoint (normally `/bridge`) and the short-lived gateway
session token supplied by the operator. Press **Connect** to open
`web_game_run.html`. The page also includes a browser fullscreen button and a
note recommending **F11**.

The token is kept only in the current tab's `sessionStorage`. The BZFlag server
password is never saved unless the player explicitly checks **Save password on
this device**; when unchecked it is removed from local preferences. The web
client does not log credentials or send them to analytics.

## Apache

Point the virtual host or an `Alias` at this directory. The included
`deploy/apache.conf` enables the MIME types used by the manifest and service
worker and keeps versioned assets cacheable. Enable HTTPS before advertising
the PWA or WebGPU path.

## Nginx

Use the included `deploy/nginx.conf` inside the relevant `server` block, or
copy its `location` directives into an existing site. Keep the static client
and the Node.js gateway on a known origin, or list the exact client origin in
the gateway's `allowedOrigins` array. When the gateway is on another origin,
use `wss://` and configure the reverse proxy for WebSocket upgrades.

## Browser paths

- WebGPU is preferred when `navigator.gpu` and an adapter are available.
- WebGL2 is selected automatically when WebGPU is unavailable.
- Current Chromium, Gecko and WebKit-based browsers are supported as far as
  their secure-context and GPU capabilities allow.
- Audio starts after the user's Connect gesture and can be muted in the game
  window. The renderer reports its selected path in the sidebar.
- The service worker caches the shell and local assets but cannot make an
  online BZFlag session playable without a network connection.

## Upstream assets and localization

`assets/upstream/` is a publishable asset-only subset copied from upstream
BZFlag revision `59b3ef44fa4538296be8b7f5eeafc2a4e57d0b74`. It includes the
runtime textures, WAV effects, font bitmaps and the sixteen locale catalogues:
`cs_CZ`, `da`, `de`, `en_US_l33t`, `en_US_redneck`, `es`, `fr`, `it`, `kg`,
`lt`, `nl`, `pt`, `ru`, `sk`, `sv` and `xx`. These files retain their upstream
notices and are not relicensed as MIT. Read `assets/upstream/README.md`,
`../NOTICE`, `../ATTRIBUTION.md` and the preserved `../COPYING*` files before
redistribution.

## Development checks

The TypeScript files are the source of truth. The build emits browser-ready
JavaScript in `dist/` and copies the compiled service worker to the client root
so Apache and Nginx can grant it the normal site-wide scope.

```sh
npm run check
npm test
```

The gateway tests use local TCP/UDP fixtures only. A real official-server
interoperability test requires an operator-provided allowlist and credentials;
CI never scans or contacts public servers.

## Credits and license

The web client and its original browser code are MIT-licensed by Sythos
([https://www.sythos.net](https://www.sythos.net)). Upstream BZFlag assets and
catalogues remain under their original LGPL-2.1/MPL-2.0 terms. Visible pages
identify the compatibility baseline as `[BZFS 2.4.31]` and show the Sythos
credit.

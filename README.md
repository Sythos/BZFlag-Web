=> BZFlag Web Client

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

[![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)](https://html.spec.whatwg.org/)
[![Node.js](https://img.shields.io/badge/Node.js-26.7.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Issues](https://img.shields.io/github/issues/Sythos/BZFlag-Web)](https://github.com/Sythos/BZFlag-Web/issues)
[![Last commit](https://img.shields.io/github/last-commit/Sythos/BZFlag-Web)](https://github.com/Sythos/BZFlag-Web/commits/main/)
[![Downloads](https://img.shields.io/github/downloads/Sythos/BZFlag-Web/total)](https://github.com/Sythos/BZFlag-Web/releases)

BZFlag Web Client is an independent browser client and Node.js gateway for the
BZFlag ecosystem. The client is a static HTML5 application whose TypeScript
sources compile to browser-ready JavaScript. The gateway is a small Node.js
service that gives the browser a controlled WebSocket boundary to an official
BZFlag server while preserving the native server-side TCP and UDP transports.

The repository is intentionally a narrow, publishable subset of the much larger
upstream BZFlag tree. It contains the gateway, the browser shell, the compiled
client output produced at build time, the required tests and the local assets
needed by the web package. The native BZFlag executable, `bzfs`, maps, plug-ins
and unrelated upstream source files are not included in `git/`.

The compatibility baseline is BZFlag/BZFS `2.4.31`, taken from the exact
upstream revision
[`59b3ef44fa4538296be8b7f5eeafc2a4e57d0b74`](https://github.com/BZFlag-Dev/bzflag/commit/59b3ef44fa4538296be8b7f5eeafc2a4e57d0b74)
on the upstream `2.4` line. The web package version is independent of that
upstream version. Public pages identify the protocol reference as `[BZFS 2.4.31]`
so that users can distinguish the web release from the game baseline.

==> Current implementation boundary

Version `0.1.2` is an MVP/prototype. It provides the connection form, session
handoff, initial keyboard and audio controls, bounded WebSocket bridge framing,
and a WebGPU/WebGL2 capability preview. It is not yet a complete playable
BZFlag client: full world simulation, native protocol/gameplay parity, complete
game media and verified official-server interoperability remain implementation
milestones. The architecture described below is the intended path, not a claim
that every target feature is already complete.

==> What the server and client do together

The browser opens `client/index.html` to enter a nickname, select an allowlisted
server and set the connection preferences normally required by a BZFlag client.
The Connect action transfers the session to `client/web_game_run.html`, which is
the independent game window. The current MVP initializes the session state,
keyboard/audio controls, bridge framing and a deterministic renderer scene
pipeline. Validated world geometry records and authoritative tanks, shots and
flags are converted into shared WebGPU/WebGL2 scene objects. The target
gameplay layer still needs the complete native world decoder, simulation and
full protocol/gameplay parity.

The browser first requests WebGPU. When no usable adapter is available, the
client selects WebGL2. Both renderer paths are designed to consume the same
world model, input layer, asset pipeline and network session. TypeScript remains
the source of truth; the static package contains the JavaScript emitted by the
build. WebAssembly is permitted for isolated, measured performance hot spots,
but it is not a required browser plug-in.

The gateway is the network boundary between the browser and BZFS. A browser
cannot open native BZFlag TCP or UDP sockets directly, and the gateway must not
become a general-purpose TCP proxy. It therefore exposes only the narrow
WebSocket/WSS endpoint required by this client, applies policy before connecting
to an upstream target, and relays bounded TCP/UDP bridge frames. The current
gateway is transport-oriented rather than a semantic translator for every
BZFlag message. Its default catalogue contains official servers only; custom
servers remain disabled while the future adapter boundary is kept extensible.

The normal deployment is:

```text
Browser client [WebGPU or WebGL2]
        |  HTTPS + WebSocket (WSS in production)
        v
Node.js BZFlag Web gateway/bridge
        |  BZFlag TCP/UDP protocol
        v
Official BZFS server [BZFS 2.4.31]
```

The client can be served by Apache, Nginx or another static HTTPS server. The
Node.js process does not serve the client files, which keeps static delivery,
cache policy and reverse-proxy deployment independent. Release automation also
produces a Docker image and server archives for the gateway.

==> Gateway/bridge operating model

For each browser connection, the gateway performs the HTTP/WebSocket handshake,
validates the configured session policy, selects an official server by stable
identifier, opens the corresponding BZFlag TCP/UDP connection and relays the
bridge envelope. Before releasing any queued browser payload, it sends the
native `BZFLAG\r\n\r\n` preamble upstream and requires the bounded `BZFS` greeting,
the configured protocol version and a valid player id. Non-BZFS services,
version mismatches, full-server responses and silent targets are closed before
client bytes can reach them. Idle, malformed, oversized or over-budget sessions
are closed instead of being forwarded indefinitely. Full native protocol
translation and gameplay parity remain later milestones.

The production configuration is allowlist-first:

=> every permitted server is an explicit host/port entry with a stable display
   name and a referenced `[BZFS 2.4.31]` version;
=> arbitrary hostnames, arbitrary ports and custom-server selection are rejected
   unless a future configuration explicitly enables them;
=> the WebSocket `Origin` is checked against the configured web origins;
=> session, frame, queue, heartbeat, byte and rate limits are enforced at the
   bridge;
=> credentials and private connection fields are excluded from normal logs;
=> health and diagnostic endpoints expose only non-sensitive metadata.

Apache or Nginx normally terminates HTTPS and forwards the WebSocket upgrade to
Node.js 26.7.0. The instructions in `server/README.md` describe the required upgrade
headers, restricted bind address and health check. HTTPS/WSS is required for a
deployed PWA and for WebGPU on a public origin; `localhost` is suitable for local
development.

The gateway is not an official BZFlag server and does not replace `bzfs`/BZFS.
It is an adapter boundary for the selected upstream server, not a promise that
the current prototype preserves every native client feature. The small protocol
boundary leaves room for semantic translation and future operator-approved
custom-server support without weakening the secure default.

==> Client rendering, input and media

The client uses plain HTML5 and TypeScript. WebGPU is the preferred renderer and
will provide modern GPU buffers, bind groups, pipelines and command encoders for
large batches of world, tank and effect geometry. WebGL2 is the friendly fallback
for current Chromium, Gecko and WebKit-based browsers that do not expose a
usable WebGPU adapter; it consumes the same scene and asset data through a
conventional browser GL context. In short, WebGPU is the fast modern path and
WebGL2 is the compatibility path.

The input layer keeps the native keyboard mapping as its compatibility source of
truth. The MVP includes the initial controls and recommends `F11` for browser
fullscreen; complete command coverage, pointer lock and touch/gamepad extensions
remain follow-up work. Audio starts from a user gesture and exposes basic mute
controls. The self-contained game window is designed to host the local sound,
image and future HTML5 video assets permitted by their respective licences.

The setup page includes the normal nickname, allowlisted server, port and player
preference fields. Password persistence is opt-in: the password remains only for
the current session unless the user enables **Save password on this device**.
Deployments may disable that preference. Stored values are not a substitute for
server-side authentication or gateway policy.

The PWA shell uses a versioned service worker and local assets. It supports static
deployment behind Apache or Nginx, uses `localStorage` only for non-sensitive
preferences and the explicit password choice, and keeps cache namespaces
separate between web releases. The localization layer follows the sixteen locale
catalogues present in the pinned upstream baseline and keeps translation data
separate from rendering and network code.

==> Installation at a glance

Use the latest stable Node.js supported by the package metadata; CI and the
container build currently use Node.js 26.7.0. Install and build the gateway from
`server/` by following [`server/README.md`](server/README.md), then serve
`client/` as static files from the HTTPS origin listed in the gateway's
`allowedOrigins` configuration. The client deployment examples are in
[`client/README.md`](client/README.md).

Keep the gateway on a private interface behind an HTTPS reverse proxy in
production. Do not expose a development gateway directly to the public
Internet. GitHub Releases provide a client archive, ZIP and tarball server
archives, a Docker package, SHA-256 checksums, an SPDX SBOM and build provenance.

==> Repository boundary and licensing

The public branch is `main`. TypeScript files are the source of truth for the
client and gateway; generated JavaScript is a release/build product. The
upstream project remains authoritative for the original BZFlag game, protocol
and native client. Files copied or adapted from upstream retain their original
headers and applicable LGPL-2.1/MPL-2.0 terms. A modified upstream file receives
only the requested `Co-author: Sythos (https://www.sythos.net)` indication in its
existing header.

New gateway, browser, packaging and documentation material authored for this
repository is MIT-licensed by Sythos. The applicable texts and notices are in
[`LICENSE-MIT`](LICENSE-MIT), [`COPYING`](COPYING),
[`COPYING.LGPL`](COPYING.LGPL), [`COPYING.MPL`](COPYING.MPL),
[`NOTICE`](NOTICE), [`AUTHORS`](AUTHORS) and
[`ATTRIBUTION.md`](ATTRIBUTION.md). Third-party fonts, media, translations and
other assets retain their own notices and are not relicensed by this project.

Please report implementation or security issues through
[GitHub Issues](https://github.com/Sythos/BZFlag-Web/issues). Do not include
passwords, private server credentials or public exploit details in an issue;
use the repository security contact instructions when appropriate.

The CI README check covers all four `README.md` files published by this tree,
including `client/assets/upstream/README.md`. The upstream asset manifest is
checked structurally while its provenance content remains under the upstream
asset licensing rules.

==> Credits

The original game is the BZFlag project and its contributors, as documented in
the preserved upstream [`AUTHORS`](AUTHORS) file. The web derivation and its
original gateway and browser components are maintained and credited to Sythos
([https://www.sythos.net](https://www.sythos.net)). Visible pages identify the
web package and the `[BZFS 2.4.31]` compatibility reference.

==> Disclaimer

This is an independent web derivation and gateway. It is not an official BZFlag
release, is not affiliated with or endorsed by the BZFlag Development Team, and
does not guarantee access to any particular server. Use it only on servers you
are authorised to contact, review the configuration before exposing a gateway,
and comply with server rules, privacy obligations and applicable law. The
software is provided under its applicable licenses and without warranties;
operators remain responsible for security, privacy, availability and compliance.

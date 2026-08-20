# BZFlag Web Client

<!--
SPDX-License-Identifier: MIT
Copyright (c) 2026 Sythos (https://www.sythos.net)
-->

[![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)](https://html.spec.whatwg.org/)
[![Node.js](https://img.shields.io/badge/Node.js-latest%20stable-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Issues](https://img.shields.io/github/issues/Sythos/BZFlag-Web)](https://github.com/Sythos/BZFlag-Web/issues)
[![Last commit](https://img.shields.io/github/last-commit/Sythos/BZFlag-Web)](https://github.com/Sythos/BZFlag-Web/commits/main/)
[![Downloads](https://img.shields.io/github/downloads/Sythos/BZFlag-Web/total)](https://github.com/Sythos/BZFlag-Web/releases)

BZFlag Web Client is a browser-facing implementation of the BZFlag client
boundary.  It combines a static HTML5 client with a small Node.js gateway so
that a modern browser can communicate with an official BZFlag server while the
server continues to speak its normal BZFlag protocol.  The web repository is a
deliberately small, publishable subset of the much larger upstream BZFlag
source tree; it contains only the assets and derived components needed by the
gateway and the browser client.

The compatibility baseline is BZFlag/BZFS `2.4.31`, extracted from the exact
upstream revision
[`59b3ef44fa4538296be8b7f5eeafc2a4e57d0b74`](https://github.com/BZFlag-Dev/bzflag/commit/59b3ef44fa4538296be8b7f5eeafc2a4e57d0b74)
on the upstream `2.4` line.  The web package version is independent of the
upstream version.  Visible client and gateway pages identify the referenced
server release as `[BZFS 2.4.31]` so that a player can distinguish the web
package version from the protocol baseline.

## What the server and client do together

The client is a normal web application: `client/index.html` collects the
nickname and connection preferences, and `client/web_game_run.html` hosts the
actual game session.  The session uses the same essential game concepts as the
native client—world state, tanks, shots, flags, teams, chat, scoreboard,
keyboard commands and audio—but renders them using browser APIs.  The client
first asks the browser for WebGPU.  Browsers without a usable WebGPU adapter
use the WebGL2 renderer instead.  Both renderers share the same world model,
input layer, asset pipeline and network session, so changing renderer does not
change the server connection.

The gateway is the network boundary between the browser and BZFS.  A browser
cannot safely open the native BZFlag TCP/UDP sockets directly, and a browser
page should never be turned into a general-purpose TCP proxy.  The gateway
therefore exposes only the narrow WebSocket/WSS endpoint needed by this client,
translates that stream to the BZFlag connection, and applies policy before a
session can reach an upstream server.  The initial release targets official
BZFlag servers.  Custom servers are intentionally not enabled by the default
configuration, although the gateway configuration keeps the server catalogue
and protocol adapter extensible for a future, explicitly opted-in mode.

The normal deployment looks like this:

```text
Browser client [WebGPU or WebGL2]
        |  HTTPS + WebSocket (WSS in production)
        v
Node.js BZFlag Web gateway/bridge
        |  BZFlag TCP/UDP protocol
        v
Official BZFS server [BZFS 2.4.31]
```

The client may be served by Apache, Nginx or another static HTTPS server.  The
Node.js process does not need to serve the client files; keeping static assets
and the gateway separate makes CDN, cache and reverse-proxy deployments
straightforward.  A Docker package for the gateway is produced by the release
workflow and published to GitHub Container Registry when a release is made.

## Gateway/bridge: operating model

The gateway maintains a bounded session for each browser connection.  It
performs the browser handshake, selects a configured official server, opens the
corresponding BZFlag connection and relays only protocol frames understood by
the web client.  It also closes idle, malformed or over-sized sessions instead
of forwarding unbounded data.

The production configuration is allowlist-first:

- each permitted server is an explicit host/port entry with a stable display
  name and a referenced `[BZFS 2.4.31]` version;
- arbitrary hostnames, arbitrary ports and custom-server selection are rejected
  unless a future configuration explicitly enables them;
- the WebSocket `Origin` is checked against configured web origins;
- session, frame, queue, heartbeat and rate limits are enforced at the bridge;
- credentials and private connection fields are never written to normal logs;
- health and diagnostic endpoints expose no game or credential payloads.

When the gateway is put behind Apache or Nginx, the reverse proxy terminates
HTTPS and forwards the WebSocket upgrade to the Node.js process.  The supplied
server instructions show the required upgrade headers, a restricted bind
address and a separate health check.  WSS and HTTPS are required for deployed
PWA and WebGPU use; `localhost` is suitable for local development.

The gateway is not an official BZFlag server and does not replace `bzfs`/BZFS.
It is an adapter that preserves compatibility with the selected upstream
server.  The protocol adapter is kept behind a small interface so that a later
version can add a different server catalogue or an explicitly configured
custom-server policy without weakening the secure default.

## Client: rendering, input and media

The client is plain HTML5 with JavaScript/TypeScript and may use WebAssembly
for isolated, performance-sensitive routines when that is measurably useful.
It does not require a native browser plug-in.

WebGPU is the preferred path.  It gives the renderer explicit modern GPU
buffers, bind groups, pipelines and command encoders, which is a good fit for
large batches of tank, world and effect geometry.  WebGL2 is the compatibility
path: it uses the same scene and asset data through a conventional browser GL
context for current Chromium, Gecko and WebKit-based browsers that do not
expose a usable WebGPU adapter.  Capability detection happens at runtime and
the page reports which path was selected.

The client keeps the native command mapping as its compatibility source of
truth.  Keyboard focus, movement, firing, jumping, chat, scoreboard and other
commands are handled by the web input layer; the setup page includes a short
note recommending `F11` for browser fullscreen.  Pointer-lock and touch/gamepad
extensions can be added without changing the wire protocol.

Audio is loaded through browser audio APIs with a user-gesture-safe startup
path.  Sound effects, music and other media remain local assets in the client
package when redistribution permits it, with provenance and license records
in the repository.  HTML5 video/media elements are available to the client
media layer for the same reason: the game window is a self-contained web client
rather than a remote desktop view.

The setup page exposes the connection fields normally needed by a BZFlag
client, including nickname, an allowlisted server, port and the relevant player
preferences.  Password persistence is opt-in: by default the password lives
only for the current session, and the user can explicitly enable the save
password flag if the deployment allows it.  Stored values are preferences,
not a substitute for server-side authentication controls.

The application shell is installable as a PWA.  A versioned service worker
caches the immutable client shell and local assets, works when the files are
served from either Apache or Nginx, and falls back cleanly when a service worker
or secure context is unavailable.  `localStorage` is used for non-sensitive
preferences and for the explicit password choice; deployments that prohibit
password persistence can disable that option in configuration.  Cache entries
are namespaced by the web package version so an update does not mix incompatible
protocol or asset files.

The localization layer follows the languages present in the upstream BZFlag
baseline.  Translation keys and locale data are kept separate from renderer
code so that adding or correcting a translation does not change the network or
GPU layers.

## Installation at a glance

The gateway requires the latest stable Node.js release supported by the current
package metadata.  Install it on a host that can reach the selected official
BZFS servers, install the dependencies in `server/`, copy the example
configuration, and set the explicit official-server allowlist.  Run the
gateway on a private interface behind an HTTPS reverse proxy for production.

Serve `client/` as static files from the same HTTPS origin listed in the
gateway's origin allowlist.  The client README contains Apache and Nginx
examples, local development commands, cache/PWA notes and the Docker gateway
workflow.  Do not expose a development gateway directly to the public
Internet.

For release consumers, GitHub Releases provide one client archive, ZIP and
tarball server archives, a Docker package, SHA-256 checksums, an SPDX SBOM and
build provenance.  The release workflow is tag-driven and does not run merely
because a branch was pushed.

## Repository and contribution boundaries

This repository is maintained on `main`.  The source provenance for the
current baseline is recorded in the release metadata and in `NOTICE`.  Local
branches or PR simulations may be used for tests, but no remote push is
performed by the build workflow without an explicit maintainer action.

The upstream project remains the authority for the original BZFlag game,
protocol and native client.  Changes that are copied or adapted from upstream
retain their original headers and applicable license.  New web gateway,
browser-client, packaging and documentation material authored for this
repository is MIT-licensed by Sythos; see [`LICENSE-MIT`](LICENSE-MIT),
[`COPYING`](COPYING), [`COPYING.LGPL`](COPYING.LGPL),
[`COPYING.MPL`](COPYING.MPL) and [`ATTRIBUTION.md`](ATTRIBUTION.md).

Please report implementation or security issues through
[GitHub Issues](https://github.com/Sythos/BZFlag-Web/issues).  Do not include
passwords, private server credentials or public exploit details in an issue;
use the repository's security contact instructions when applicable.

## Credits

The original game is the BZFlag project and its contributors, as documented in
the preserved upstream `AUTHORS` file.  The web derivation and its original web
components are maintained and credited to **Sythos** ([sythos.net](https://www.sythos.net)).
Visible pages identify the current web package and `[BZFS 2.4.31]` reference in
their footer.

## Disclaimer

This is an independent web derivation and gateway.  It is not an official
BZFlag release, is not affiliated with or endorsed by the BZFlag Development
Team, and does not guarantee access to any particular server.  Use it only on
servers you are authorised to contact and review the configuration before
exposing a gateway to the Internet.  The software is provided under its
applicable licenses and without warranties; operators are responsible for
security, privacy, availability, server rules and compliance with all
applicable laws and third-party terms.


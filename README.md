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

BZFlag Web Client is a browser-facing MVP/prototype of the BZFlag client
boundary.  It combines a static HTML5 client with a small Node.js gateway so
that the web client can be developed against an official BZFlag server while
the server continues to speak its normal BZFlag protocol.  The web repository
is a deliberately small, publishable subset of the much larger upstream BZFlag
source tree; it contains only the assets and derived components needed by the
gateway and the browser client.

The compatibility baseline is BZFlag/BZFS `2.4.31`, extracted from the exact
upstream revision
[`59b3ef44fa4538296be8b7f5eeafc2a4e57d0b74`](https://github.com/BZFlag-Dev/bzflag/commit/59b3ef44fa4538296be8b7f5eeafc2a4e57d0b74)
on the upstream `2.4` line.  The web package version is independent of the
upstream version.  Visible client and gateway pages identify the referenced
server release as `[BZFS 2.4.31]` so that a player can distinguish the web
package version from the protocol baseline.

> **Current status — MVP/prototype.** Version `0.1.0` currently provides the
> connection form, session handoff, initial keyboard/audio controls, bounded
> WebSocket bridge framing and WebGPU/WebGL2 capability preview.  It is not yet
> a full playable BZFlag client: complete world simulation, native protocol and
> gameplay parity, integrated game media, and verified official-server
> interoperability remain implementation milestones.  The documentation below
> describes the target architecture as well as the current boundary; it is not
> a claim that every target feature is already complete.

## What the server and client do together

The target client is a normal web application: `client/index.html` collects the
nickname and connection preferences, and `client/web_game_run.html` hosts the
independent game window.  In the current MVP, that window wires session state,
initial input/audio controls, bridge framing and a renderer capability preview;
it does not yet implement the complete native game loop.  The target session
will cover the same essential concepts as the native client—world state,
tanks, shots, flags, teams, chat, scoreboard, keyboard commands and audio—using
browser APIs.  The client first asks the browser for WebGPU.  Browsers without
a usable WebGPU adapter use the WebGL2 renderer instead.  The two renderers are
intended to share the world model, input layer, asset pipeline and network
session; this shared gameplay layer is still being built.

The gateway is the network boundary between the browser and BZFS.  A browser
cannot safely open the native BZFlag TCP/UDP sockets directly, and a browser
page should never be turned into a general-purpose TCP proxy.  The MVP gateway
therefore exposes only the narrow WebSocket/WSS endpoint needed by this client,
applies policy before a session can reach an upstream server, and relays the
bounded TCP/UDP bridge frames.  It is not yet a semantic translator for every
BZFlag protocol message.  The initial configuration targets official BZFlag
servers.  Custom servers are intentionally not enabled by default, although
the gateway configuration keeps the server catalogue and future protocol
adapters extensible for an explicitly opted-in mode.

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
corresponding BZFlag TCP/UDP connections and relays the bridge frames.  It also
closes idle, malformed or over-sized sessions instead of forwarding unbounded
data.  Understanding and translating the full native protocol remains a later
client/gateway milestone; the current relay must not be read as a claim of full
gameplay compatibility.

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
It is the MVP adapter boundary for the selected upstream server, not a promise
that the current prototype already preserves every native client feature.  The
protocol boundary is kept small so that a later version can add semantic
translation, a different server catalogue or an explicitly configured
custom-server policy without weakening the secure default.

## Client: rendering, input and media

The client is plain HTML5 with TypeScript as its source of truth and compiled
JavaScript in the static package. WebAssembly may be used for isolated,
performance-sensitive routines when that is measurably useful. It does not
require a native browser plug-in.

WebGPU is the preferred path.  It gives the eventual renderer explicit modern
GPU buffers, bind groups, pipelines and command encoders, which is a good fit
for large batches of tank, world and effect geometry.  WebGL2 is the
compatibility path: it will use the same scene and asset data through a
conventional browser GL context for current Chromium, Gecko and WebKit-based
browsers that do not expose a usable WebGPU adapter.  The MVP already detects
capabilities and reports the selected preview path; the full scene renderer is
not complete yet.

The client keeps the native command mapping as its intended compatibility
source of truth.  The MVP includes the initial keyboard mapping and controls;
complete native command coverage, pointer-lock and touch/gamepad extensions
remain follow-up work.  The setup page includes a short note recommending
`F11` for browser fullscreen.

The MVP starts browser audio through a user-gesture-safe path and exposes basic
audio controls.  Full sound effects, music and other game media remain target
work; when redistribution permits them, they will stay local assets in the
client package with provenance and license records in the repository.  HTML5
video/media support is likewise part of the target self-contained game window,
not a feature claim for the current preview.

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
gateway's origin allowlist.  The [`client/README.md`](client/README.md) contains
Apache and Nginx examples, local development commands, cache/PWA notes and the
Docker gateway workflow.  Do not expose a development gateway directly to the
public Internet.

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
retain their original headers and applicable license.  A modified upstream
file receives only a `Co-author: Sythos (https://www.sythos.net)` indication in
its existing header; the upstream notice and license are not replaced.  New
web gateway,
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

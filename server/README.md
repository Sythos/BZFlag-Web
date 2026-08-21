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

=> BZFlag Web Gateway

The gateway is a small TypeScript service that gives the browser client a
controlled WebSocket boundary to an official BZFlag server. Its compiled Node.js
runtime uses only built-in modules: browser messages arrive as masked binary
WebSocket frames, the gateway validates the session and forwards bounded payloads
to an allowlisted TCP or UDP endpoint, and data received from the game server is
returned in the same bridge envelope.

This is a transport bridge, not a BZFlag game server. The package does not
contain `bzfs`, maps, plug-ins or any upstream game executable. The default
configuration permits only entries marked `official`; entries marked `custom`
remain rejected until a future operator-approved policy enables them.

==> Requirements

=> Node.js 26.7.0 or a newer supported stable release. CI and the Docker image use
   Node.js 26.7.0.
=> npm for the TypeScript 7.0.2 build and development checks. The production
   runtime has no third-party dependency.
=> A browser client served from an origin listed exactly in `allowedOrigins`.
=> Network access from the gateway host to the selected official BZFlag server.

The runtime uses only Node.js built-ins. The TypeScript compiler and Node.js type
definitions are development dependencies installed by `npm ci` and used by
`npm run build`.

==> Local installation

Run these commands from `server/`:

```sh
cp ./config.example.json ./config.json
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npm ci
npm run build
```

Put the generated value in `config.json` as `sessionToken`, replace
`replace-with-an-approved-official-host` with a server you are authorised to
use, and start the service:

```sh
npm start
```

On Windows PowerShell, use `Copy-Item ./config.example.json ./config.json` for
the first step. The default listener is `127.0.0.1:8080`; check it with
`http://127.0.0.1:8080/healthz`. An alternate configuration can be supplied with
`node ./dist/gateway.js --config ./config.json` or the `BZFLAG_WEB_CONFIG`
environment variable.

The gateway never prints the bearer token. For a stable production secret, set
`BZFLAG_WEB_SESSION_TOKEN` through the service manager or container secret store,
or keep it in the private `config.json`. If no token is supplied, a random token
is generated for that process and is intentionally not recoverable from logs.
Never commit the token or place it in a public client bundle. A token in a
browser URL is visible to the browser and local browser tooling, so deployments
that need stronger isolation should use a short-lived reverse-proxy/session
design.

==> Configuration

`config.example.json` is deliberately explicit. The principal fields are:

| Field | Meaning |
| --- | --- |
| `host`, `port` | Local listener. Use an IPv4 literal such as `127.0.0.1`, an IPv6 literal such as `::1`, or `::` for a dual-stack host where the operating system permits it. Keep it private until TLS and proxy rules are ready. |
| `sessionToken` | Required browser session token. |
| `allowLegacyQueryToken` | Keep `true` only while older clients still send the token in the query string; set `false` after migration to the subprotocol transport. |
| `allowedOrigins` | Exact `http://` or `https://` browser origins. Do not use `*`. |
| `servers` | The only target addresses the gateway may dial. |
| `allowCustomServers` | Keep `false` for official-server-only operation. |
| `allowPrivateAddresses` | Keep `false` in production. Set `true` only for an explicitly isolated local fixture or development test. |
| `limits` | Frame, control-frame, continuation, queue, throughput, handshake, parser, session and idle limits. |
| `trustProxy`, `trustedProxyPeers` | Forwarded client IPs are used only when the direct peer is an exact trusted proxy address. |

The browser submits a target identifier rather than a host or port. Current
clients send the bearer in the WebSocket subprotocol offer, so it is not part
of the URL:

```text
ws(s)://gateway.example.test/bridge?server=official-main
```

The offer contains `bzflag-web-v1` and a `bzflag-token.<base64url-token>` entry;
the gateway authenticates the token and returns `Sec-WebSocket-Protocol:
bzflag-web-v1`. The `allowLegacyQueryToken` compatibility switch accepts the
older `?token=...` form until all deployed clients have migrated. Disable it in
production once that transition is complete.

IPv4 and IPv6 are supported on both sides of the bridge. In the operator
configuration, write an IPv6 target as a raw literal such as `2001:db8::20`
(without URL brackets); DNS names may return A and AAAA records, and the
gateway validates every returned address before selecting one. In a browser
gateway URL, use the normal URL bracket form, for example
`ws://[::1]:8080/bridge`. The WebSocket layer carries the same BZWB envelope
over either address family, while the gateway chooses `tcp4`/`tcp6` and
`udp4`/`udp6` to match the selected BZFS endpoint.

The service does not trust `Host`, client-supplied target addresses or
`X-Forwarded-For` by default. `trustProxy` is rejected unless
`trustedProxyPeers` contains at least one literal IP address. When enabled, a
forwarded address is accepted only from an exact trusted peer and only when the
first forwarded value is itself a literal IP. CIDR ranges and proxy hostnames
are deliberately not accepted. The forwarded address affects only per-client
session counting.

Target hostnames are resolved once per connection and the resulting address is
pinned for both TCP and UDP. Private, loopback, link-local, multicast,
metadata-service, documentation and other reserved address ranges are rejected
by default. `allowPrivateAddresses` is a local-fixture escape hatch only; do not
enable it on a public gateway.

Before any queued browser payload is released, the gateway performs the native
upstream preflight itself: it sends `BZFLAG\r\n\r\n`, waits for the bounded
nine-byte `BZFS` greeting, checks the configured four-digit protocol version and
rejects player id `255` or any non-BZFS response. TCP and UDP client traffic is
held until that check and the UDP socket are both ready. `limits.targetHandshakeTimeoutMs`
closes silent or non-cooperating targets quickly. This prevents an accidentally
misconfigured HTTP, SSH or arbitrary TCP service from being used as a relay.

==> WebSocket bridge envelope

New clients send one binary WebSocket message per bridge message. The first
eight bytes are:

| Bytes | Value |
| --- | --- |
| 0-3 | ASCII `BZWB` |
| 4 | Envelope version `1` |
| 5 | Channel: `0` TCP, `1` UDP |
| 6-7 | Reserved flags, currently `0` |
| 8+ | Raw BZFlag payload |

The gateway returns the same envelope for data received from the target. A
message without the `BZWB` marker is accepted as a raw TCP compatibility
message; new clients should always use the envelope so that UDP traffic remains
explicit. A TCP stream chunk is not a BZFlag application-packet boundary, so
the client must retain the normal BZFlag framing rules.

The default metadata is BZFlag `2.4.31` with BZFS protocol `0221`, inherited
from the pinned upstream baseline. The gateway is transport-transparent and
does not claim compatibility with a newer or differently configured server just
because a socket opens. Future custom-server support must add explicit protocol
negotiation and operator approval.

The limits are intentionally separate. `maxFramesPerSecond` covers every client
frame, `maxControlFramesPerSecond` covers ping/pong/close frames,
`maxContinuationFrames` counts continuation frames after a non-final binary
frame, and `maxContinuationBytes` caps the assembled fragmented message.
`handshakeTimeoutMs` covers the HTTP upgrade parser and `parserTimeoutMs` covers
a frame that remains incomplete after its first bytes arrive;
`targetHandshakeTimeoutMs` bounds the upstream BZFS identity preflight.

==> Security properties

=> Exact Origin allowlisting is required for every WebSocket upgrade.
=> A constant-time session-token comparison is required for every bridge session.
=> New clients carry the bearer in the WebSocket subprotocol instead of the URL;
   query-string authentication is an explicit, temporary compatibility mode.
=> Target hosts and ports come only from the operator configuration allowlist.
=> Custom entries are denied while `allowCustomServers` is `false`.
=> Frame size, buffered output, message rate, byte rate, total sessions,
   per-IP sessions and idle sessions are bounded.
=> Handshake and incomplete-frame parser deadlines are enforced, and the
   WebSocket socket has a real idle timeout.
=> Frame rate, control-frame rate, fragmented-message count and fragmented-byte
   budgets are bounded independently.
=> Client text frames, unmasked frames, unsupported extensions, unknown bridge
   channels and reserved envelope flags are rejected.
=> The process does not log tokens or game payloads.
=> The health endpoint exposes only version and count metadata for a local
   reverse-proxy or container check.

The gateway is not a complete security boundary by itself. Deploy it behind
TLS/WSS, restrict firewall access, keep the allowlist short, rotate tokens and
run the repository security and compliance checks before a public release.

==> Docker

Build from `server/`:

```sh
docker build -t sythos/bzflag-web-gateway:local .
docker run --rm --name bzflag-web-gateway \
  -p 8080:8080 \
  -v "./config.json:/app/config.json:ro" \
  sythos/bzflag-web-gateway:local
```

The multi-stage image uses `node:26.7.0-alpine` to compile TypeScript in a
disposable build stage. The final image contains only the compiled gateway, its
installation page, `package.json` and the standalone MIT license. Configuration
is mounted at runtime. The container runs as the unprivileged `node` user and
listens on all container interfaces so a published port can reach it (the
non-container default remains `127.0.0.1`). It exposes a `/healthz` Docker
health check. TLS normally terminates at Apache or
Nginx; direct TLS is also supported through `tls.keyFile` and `tls.certFile` in
a configuration file mounted into the container.

==> Testing

```sh
npm run check
npm test
```

The suite uses local TCP and UDP fixtures only. It does not contact or scan
public BZFlag servers. Release CI additionally builds the TypeScript output,
checks the emitted JavaScript, validates the HTML entry points and verifies
license, workflow and provenance invariants.

==> License and upstream relationship

The gateway code, documentation, installation page and container definition are
original work by Sythos and are available under the MIT License in
[`LEGAL-MIT.txt`](./LEGAL-MIT.txt). BZFlag remains a separate upstream project under
its original LGPL-2.1/MPL-2.0 terms; the repository-level texts are available at
[`../COPYING`](../COPYING), [`../COPYING.LGPL`](../COPYING.LGPL) and
[`../COPYING.MPL`](../COPYING.MPL). Upstream notices and provenance are recorded
in [`../NOTICE`](../NOTICE), [`../AUTHORS`](../AUTHORS) and
[`../ATTRIBUTION.md`](../ATTRIBUTION.md). This gateway is not an official BZFlag
distribution and is not affiliated with the BZFlag project.

Sythos (https://www.sythos.net) [BZFlag 2.4.31 / BZFS protocol 0221]

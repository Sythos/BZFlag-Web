<!--
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

# BZFlag Web Gateway

The gateway is a small TypeScript service whose compiled Node.js runtime has no production dependencies. It lets the browser client reach a BZFlag server through a WebSocket connection. It keeps the browser transport separate from the native BZFlag transport: browser messages arrive as masked WebSocket binary frames, and the gateway forwards their payloads to an allowlisted TCP or UDP endpoint. Data coming back from the game server is wrapped in the same envelope and sent to the browser.

It is a bridge, not a BZFlag game server. The image and process in this directory do not include `bzfs`, maps, plug-ins, or any upstream game executable. The default configuration only permits entries marked `official`; entries marked `custom` are intentionally rejected until an operator explicitly enables them.

## Requirements

- Node.js 22 or a newer supported stable release.
- npm (used to compile the TypeScript source; the runtime itself has no package dependency).
- A browser client served from an origin listed in `allowedOrigins`.
- Network access from the gateway host to the selected official BZFlag server.

The runtime uses only Node.js built-ins. The TypeScript compiler and Node.js type definitions are development dependencies used by `npm ci` and `npm run build`.

## Local installation

From this directory:

```sh
cp ./config.example.json ./config.json
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npm ci
npm run build
```

Put the generated value in `config.json` as `sessionToken`, replace `replace-with-an-approved-official-host` with a server you are authorised to use, and start the service:

```sh
npm start
```

On Windows PowerShell, use `Copy-Item ./config.example.json ./config.json` for the first step. The gateway binds to `127.0.0.1:8080` by default. Use `http://127.0.0.1:8080/healthz` to check it. Pass another file with `node ./dist/gateway.js --config ./config.json` or set `BZFLAG_WEB_CONFIG`.

The gateway never prints the bearer token. For a stable production secret, set `BZFLAG_WEB_SESSION_TOKEN` through the service manager or container secret store, or put it in the private `config.json`. If no token is supplied, a random token is generated for that process and is intentionally not recoverable from logs. Do not put the token in a public repository or a client bundle. A token in the browser URL is visible to the browser and to local browser tooling, so use a short-lived reverse-proxy/session design if the deployment needs stronger credential isolation.

## Configuration

`config.example.json` is deliberately explicit. The important fields are:

| Field | Meaning |
| --- | --- |
| `host`, `port` | Local listener. Keep the listener private until TLS and proxy rules are ready. |
| `sessionToken` | Required browser session token. |
| `allowedOrigins` | Exact `http://` or `https://` browser origins. Avoid `*`. |
| `servers` | The only target addresses the gateway will ever dial. |
| `allowCustomServers` | Must stay `false` for the official-server-only deployment. |
| `limits` | Frame, control-frame, continuation, queue, throughput, handshake, parser, session-count, and idle-time limits. |
| `trustProxy`, `trustedProxyPeers` | Forwarded client IPs are used only when `trustProxy` is `true` **and** the direct peer IP is listed exactly in `trustedProxyPeers`. |

The browser supplies the target id, not a host or port:

```text
ws(s)://gateway.example.test/bridge?server=official-main&token=YOUR_SESSION_TOKEN
```

The service does not trust `Host`, client-supplied target addresses, or `X-Forwarded-For` by default. `trustProxy` is rejected unless `trustedProxyPeers` contains at least one literal IP address. Even when enabled, an `X-Forwarded-For` value is accepted only when the direct TCP peer is in that exact list and the first forwarded value is itself a literal IP. CIDR ranges and proxy hostnames are deliberately not accepted. The forwarded address only changes the IP used for per-client session counting.

## WebSocket bridge envelope

New clients send one binary WebSocket message per bridge message. The first eight bytes are:

| Bytes | Value |
| --- | --- |
| 0-3 | ASCII `BZWB` |
| 4 | Envelope version `1` |
| 5 | Channel: `0` TCP, `1` UDP |
| 6-7 | Reserved flags, currently `0` |
| 8+ | Raw BZFlag payload |

The gateway returns the same envelope for data received from the target. A message without the `BZWB` marker is accepted as a raw TCP compatibility message. New clients should always use the envelope so that UDP traffic is explicit. A TCP stream chunk is not a BZFlag application packet boundary; the client must retain the normal BZFlag framing rules.

The default metadata is BZFlag `2.4.31` with BZFS protocol `0221`, inherited from the pinned upstream baseline. The gateway is transport-transparent and does not claim that a newer or differently configured server is compatible merely because a socket opened. Future custom-server work must add explicit protocol negotiation and operator approval.

The WebSocket limits are intentionally separate: `maxFramesPerSecond` covers every client frame, `maxControlFramesPerSecond` covers ping/pong/close control frames, `maxContinuationFrames` counts continuation frames after the first non-final binary frame, and `maxContinuationBytes` caps the assembled fragmented message. `handshakeTimeoutMs` covers the HTTP upgrade parser and `parserTimeoutMs` covers a frame that remains incomplete after its first bytes arrive.

## Security properties

- Exact Origin allowlisting is required for every WebSocket upgrade.
- A constant-time session-token comparison is required for every bridge session.
- Target host and ports come only from the operator configuration allowlist.
- Custom entries are denied while `allowCustomServers` is `false`.
- Frame size, buffered output, message rate, byte rate, total sessions, per-IP sessions, and idle sessions are bounded.
- Handshake and incomplete-frame parser deadlines are enforced; the WebSocket socket also has a real idle timeout.
- Total frame rate, control-frame rate, fragmented-message frame count, and fragmented-message byte count are bounded independently.
- Client text frames, unmasked frames, unsupported extensions, unknown bridge channels, and reserved envelope flags are rejected.
- The process does not log tokens or game payloads.
- The health endpoint contains only version and count metadata and is intended for a local reverse proxy/container check.

The gateway is not a complete security boundary by itself. Deploy it behind TLS/WSS, restrict firewall access, keep the allowlist short, rotate tokens, and run the repository security/compliance checks before a public release.

## Docker

Build from this directory:

```sh
docker build -t sythos/bzflag-web-gateway:local .
docker run --rm --name bzflag-web-gateway \
  -p 8080:8080 \
  -v "./config.json:/app/config.json:ro" \
  sythos/bzflag-web-gateway:local
```

The multi-stage image compiles TypeScript in a disposable build stage and the final image contains only the compiled gateway, its installation page, `package.json`, and the MIT license. Configuration is mounted at runtime. The container uses the unprivileged `node` user and exposes a `/healthz` Docker health check. TLS is normally terminated by Apache or Nginx; direct TLS is also supported by supplying `tls.keyFile` and `tls.certFile` in a configuration file mounted into the container.

## Testing

```sh
npm test
npm run check
```

The test suite uses local TCP/UDP sockets only. It does not contact or scan public BZFlag servers.

## License and upstream relationship

The new gateway code, documentation, page, and container definition are original work by Sythos and are available under the MIT License in [`LICENSE-MIT`](./LICENSE-MIT). BZFlag itself remains a separate upstream project under its original LGPL-2.1/MPL-2.0 terms. This gateway is not an official BZFlag distribution and is not affiliated with the BZFlag project.

Sythos (https://www.sythos.net) [BZFlag 2.4.31 / BZFS protocol 0221]

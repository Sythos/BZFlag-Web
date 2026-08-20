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
 *
 * Browser E2E gate for the static client. The fixture implements only the
 * localhost WebSocket boundary: it never contacts an official or custom BZFS.
 */

import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

const repositoryRoot = resolve(process.cwd());
const clientRoot = resolve(repositoryRoot, "client");
const fixtureToken = "bzflag-web-e2e-fixture-token";
const fixtureTokenSubprotocol = `bzflag-token.${Buffer.from(fixtureToken, "utf8").toString("base64url")}`;
const expectedServerId = "official-main";
const screenshotPath = process.env.E2E_SCREENSHOT;
const failures = [];

function fail(message) {
  failures.push(message);
  throw new Error(message);
}

function contentType(path) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".wav": "audio/wav",
    ".xpm": "text/plain; charset=utf-8",
    ".po": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
  }[extname(path).toLowerCase()] || "application/octet-stream";
}

function isInsideRoot(path) {
  const target = resolve(path);
  const root = `${clientRoot}${sep}`;
  return target === clientRoot || target.startsWith(root);
}

function websocketAccept(key) {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

function websocketFrame(payload, opcode = 0x2) {
  const body = Buffer.from(payload);
  if (body.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
  if (body.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

const BRIDGE_MAGIC = Buffer.from([0x42, 0x5a, 0x57, 0x42]);
const BRIDGE_VERSION = 1;
const CHANNEL_TCP = 0;
const CHANNEL_UDP = 1;
const SERVER_GREETING = Buffer.concat([Buffer.from("BZFS0221", "ascii"), Buffer.from([7])]);
const MSG_ACCEPT = 0x6163;
const MSG_ENTER = 0x656e;
const MSG_NEGOTIATE_FLAGS = 0x6e66;
const MSG_QUERY_GAME = 0x7167;
const MSG_QUERY_PLAYERS = 0x7170;
const MSG_UDP_LINK_REQUEST = 0x6f66;
const MSG_UDP_LINK_ESTABLISHED = 0x6f67;

function bridgeEnvelope(channel, payload) {
  const body = Buffer.from(payload);
  const envelope = Buffer.alloc(8);
  BRIDGE_MAGIC.copy(envelope, 0);
  envelope[4] = BRIDGE_VERSION;
  envelope[5] = channel;
  return Buffer.concat([envelope, body]);
}

function bzFlagPacket(code, payload = Buffer.alloc(0)) {
  const body = Buffer.from(payload);
  if (body.length > 0xffff) throw new RangeError("Fixture BZFlag packet is too large");
  const packet = Buffer.alloc(4 + body.length);
  packet.writeUInt16BE(body.length, 0);
  packet.writeUInt16BE(code, 2);
  body.copy(packet, 4);
  return packet;
}

function sendBridgePayload(socket, channel, payload) {
  socket.write(websocketFrame(bridgeEnvelope(channel, payload)));
}

function parseWebSocketFrames(buffer, onFrame) {
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const masked = (second & 0x80) !== 0;
    let payloadLength = second & 0x7f;
    let headerLength = 2;
    if (payloadLength === 126) {
      if (buffer.length - offset < 4) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (buffer.length - offset < 10) break;
      const length = buffer.readBigUInt64BE(offset + 2);
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Fixture WebSocket frame is too large");
      payloadLength = Number(length);
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + payloadLength;
    if (buffer.length - offset < frameLength) break;
    const maskOffset = offset + headerLength;
    const payloadOffset = maskOffset + maskLength;
    const payload = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + payloadLength));
    if (masked) {
      const mask = buffer.subarray(maskOffset, payloadOffset);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    onFrame({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload });
    offset += frameLength;
  }
  return buffer.subarray(offset);
}

function serveStatic(request, response) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url || "/", "http://fixture.invalid").pathname);
  } catch {
    response.writeHead(400).end("Invalid URL");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const target = resolve(clientRoot, `.${pathname}`);
  if (!isInsideRoot(target)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  stat(target).then((info) => {
    if (!info.isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": contentType(target),
      "content-length": info.size,
    });
    createReadStream(target).pipe(response);
  }).catch(() => response.writeHead(404).end("Not found"));
}

function startFixture() {
  const state = {
    upgradeCount: 0,
    binaryMessages: 0,
    gatewayHandshakeReceived: false,
    enterPackets: 0,
    enterNickname: null,
    acceptSent: 0,
    udpLinkRequests: 0,
    udpLinkEstablished: 0,
    receivedServerId: null,
    receivedToken: null,
    errors: [],
  };
  const server = createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url || "/", "http://fixture.invalid");
    } catch {
      response.writeHead(400).end("Invalid URL");
      return;
    }
    if (request.method === "GET" && url.pathname === "/__fixture__/state") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(state));
      return;
    }
    serveStatic(request, response);
  });

  server.on("upgrade", (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url || "/", "http://fixture.invalid");
    } catch {
      socket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"];
    const origin = request.headers.origin;
    const upgrade = String(request.headers.upgrade || "").toLowerCase();
    const protocols = String(request.headers["sec-websocket-protocol"] || "")
      .split(",").map((protocol) => protocol.trim()).filter(Boolean);
    if (url.pathname !== "/bridge" || upgrade !== "websocket" || typeof key !== "string"
      || url.searchParams.get("server") !== expectedServerId || url.searchParams.has("token")
      || !protocols.includes("bzflag-web-v1") || !protocols.includes(fixtureTokenSubprotocol)
      || origin !== `http://127.0.0.1:${server.address()?.port}`) {
      state.errors.push(`Rejected fixture upgrade: ${request.url || ""}`);
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    state.upgradeCount += 1;
    state.receivedServerId = url.searchParams.get("server");
    state.receivedToken = fixtureToken;
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      "Sec-WebSocket-Protocol: bzflag-web-v1",
      "\r\n",
    ].join("\r\n"));

    const channelBuffers = new Map([
      [CHANNEL_TCP, Buffer.alloc(0)],
      [CHANNEL_UDP, Buffer.alloc(0)],
    ]);
    // This fixture represents the already-hardened gateway boundary. The
    // gateway performs the outbound BZFLAG/BZFS validation before exposing
    // this WebSocket, so the browser receives the validated greeting first.
    state.gatewayHandshakeReceived = true;
    sendBridgePayload(socket, CHANNEL_TCP, SERVER_GREETING);

    const sendAccept = () => {
      if (state.acceptSent > 0) return;
      state.acceptSent += 1;
      sendBridgePayload(socket, CHANNEL_TCP, bzFlagPacket(MSG_ACCEPT));
    };

    const handlePacket = (channel, packet) => {
      if (packet.length < 4) {
        state.errors.push("Fixture received a truncated BZFlag packet");
        return;
      }
      const payloadLength = packet.readUInt16BE(0);
      const code = packet.readUInt16BE(2);
      const expectedLength = 4 + payloadLength;
      if (expectedLength !== packet.length) {
        state.errors.push(`Fixture received an invalid BZFlag packet length for 0x${code.toString(16)}`);
        return;
      }
      const payload = packet.subarray(4);
      if (code === MSG_ENTER) {
        state.enterPackets += 1;
        if (payload.length >= 36) {
          state.enterNickname = payload.subarray(4, 36).toString("utf8").replace(/\0+$/g, "");
        }
        sendAccept();
        return;
      }
      if (code === MSG_UDP_LINK_REQUEST && channel === CHANNEL_UDP) {
        state.udpLinkRequests += 1;
        sendBridgePayload(socket, CHANNEL_TCP, bzFlagPacket(MSG_UDP_LINK_ESTABLISHED));
        sendBridgePayload(socket, CHANNEL_UDP, bzFlagPacket(MSG_UDP_LINK_REQUEST, payload.subarray(0, 1)));
        return;
      }
      if (code === MSG_UDP_LINK_ESTABLISHED && channel === CHANNEL_UDP) {
        state.udpLinkEstablished += 1;
        return;
      }
      if (code === MSG_NEGOTIATE_FLAGS && channel === CHANNEL_TCP) {
        sendBridgePayload(socket, CHANNEL_TCP, bzFlagPacket(MSG_NEGOTIATE_FLAGS));
        return;
      }
      if (code === MSG_QUERY_GAME && channel === CHANNEL_TCP) {
        sendBridgePayload(socket, CHANNEL_TCP, bzFlagPacket(MSG_QUERY_GAME, Buffer.alloc(44)));
        return;
      }
      if (code === MSG_QUERY_PLAYERS && channel === CHANNEL_TCP) {
        return;
      }
    };

    const consumeClientPayload = (channel, payload) => {
      let pending = Buffer.concat([channelBuffers.get(channel), Buffer.from(payload)]);
      while (pending.length >= 4) {
        const payloadLength = pending.readUInt16BE(0);
        const packetLength = 4 + payloadLength;
        if (pending.length < packetLength) break;
        handlePacket(channel, pending.subarray(0, packetLength));
        pending = pending.subarray(packetLength);
      }
      channelBuffers.set(channel, pending);
    };

    const onFrame = ({ opcode, payload }) => {
      if (opcode === 0x2) {
        if (payload.length < 8 || !payload.subarray(0, 4).equals(BRIDGE_MAGIC)
          || payload[4] !== BRIDGE_VERSION || ![CHANNEL_TCP, CHANNEL_UDP].includes(payload[5])
          || payload[6] !== 0 || payload[7] !== 0) {
          state.errors.push("Client binary message did not use the BZWB envelope");
          return;
        }
        state.binaryMessages += 1;
        consumeClientPayload(payload[5], payload.subarray(8));
      } else if (opcode === 0x9) {
        socket.write(websocketFrame(payload, 0xA));
      } else if (opcode === 0x8) {
        socket.end();
      } else {
        state.errors.push(`Fixture received unsupported WebSocket opcode 0x${opcode.toString(16)}`);
      }
    };
    let pending = Buffer.from(head || []);
    try {
      pending = parseWebSocketFrames(pending, onFrame);
    } catch (error) {
      state.errors.push(error.message);
      socket.destroy();
      return;
    }
    socket.on("data", (chunk) => {
      try {
        pending = parseWebSocketFrames(Buffer.concat([pending, chunk]), onFrame);
      } catch (error) {
        state.errors.push(error.message);
        socket.destroy();
      }
    });
  });

  return new Promise((resolveFixture, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Fixture server did not expose a TCP port"));
        return;
      }
      resolveFixture({ server, state, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function requireLocalAssets() {
  const serviceWorker = await readFile(resolve(clientRoot, "service-worker.ts"), "utf8");
  const references = [...serviceWorker.matchAll(/["'](\.[/][^"']+)["']/g)].map((match) => match[1]);
  const assetManifest = JSON.parse(await readFile(resolve(clientRoot, "assets/asset-manifest.json"), "utf8"));
  if (!Array.isArray(assetManifest.entries)) fail("Asset manifest does not contain an entries array");
  references.push(...assetManifest.entries.map((entry) => entry?.path));
  const uniqueReferences = [...new Set(references)];
  for (const reference of uniqueReferences) {
    if (typeof reference !== "string" || !reference.startsWith("./") || reference.includes("://")) {
      fail(`Asset manifest contains an invalid local reference: ${String(reference)}`);
    }
    const target = resolve(clientRoot, reference);
    if (!isInsideRoot(target)) fail(`Service-worker asset escapes client root: ${reference}`);
    try {
      const info = await stat(target);
      if (!info.isFile()) fail(`Service-worker asset is not a file: ${reference}`);
    } catch {
      fail(`Service-worker asset is missing: ${reference}`);
    }
  }
  return uniqueReferences;
}

function playwright() {
  const require = createRequire(import.meta.url);
  const moduleName = process.env.PLAYWRIGHT_MODULE || "playwright";
  try {
    return require(moduleName);
  } catch (error) {
    throw new Error(`Playwright is required for the browser E2E gate (${moduleName}): ${error.message}`);
  }
}

async function run() {
  const serviceWorkerReferences = await requireLocalAssets();
  const fixture = await startFixture();
  let browser;
  try {
    const { chromium } = playwright();
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox"],
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
    });
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.__bzflagE2ePackets = [];
      document.addEventListener("bzflag:packet", (event) => {
        const detail = event.detail || {};
        window.__bzflagE2ePackets.push({
          code: detail.code,
          channel: detail.channel,
          valid: detail.valid,
        });
      });
    });
    const page = await context.newPage();
    const consoleMessages = [];
    const requestFailures = [];
    page.on("console", (message) => {
      const text = message.text();
      const expectedBrowserNoise = /(?:powerPreference option is currently ignored when calling requestAdapter|No available adapters\.|GL Driver Message .*GPU stall due to ReadPixels)/i.test(text);
      if (["error", "warning"].includes(message.type()) && !expectedBrowserNoise) consoleMessages.push(`${message.type()}: ${text}`);
    });
    page.on("pageerror", (error) => consoleMessages.push(`pageerror: ${error.message}`));
    page.on("requestfailed", (request) => requestFailures.push(`${request.url()}: ${request.failure()?.errorText || "request failed"}`));

    const entryUrl = `${fixture.baseUrl}/index.html?e2e=1`;
    await page.goto(entryUrl, { waitUntil: "networkidle" });
    if (await page.title() !== "BZFlag Web Client · Connect") fail("Connect page identity did not match the expected title");
    if (!(await page.locator("#connect-form").isVisible())) fail("Connect form is not visible");
    const connectButton = page.locator("button[type=submit]");
    if (!(await connectButton.isVisible())) fail("Connect button is not visible");

    const pwaState = await page.evaluate(async (expectedReferences) => {
      if (!("serviceWorker" in navigator)) return { supported: false, active: false, cached: [] };
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Service worker did not become ready")), 30000)),
      ]);
      const cacheName = (await caches.keys()).find((name) => name.startsWith("bzflag-web-client-"));
      const cache = cacheName ? await caches.open(cacheName) : null;
      const cached = cache ? (await cache.keys()).map((request) => new URL(request.url).pathname) : [];
      const expected = expectedReferences.map((reference) => new URL(reference, location.href).pathname);
      return {
        supported: true,
        active: Boolean(registration.active),
        cached,
        missing: expected.filter((pathname) => !cached.includes(pathname) && pathname !== "/"),
      };
    }, serviceWorkerReferences);
    if (!pwaState.supported) fail("Browser does not support service workers on the test origin");
    if (!pwaState.active) fail("PWA service worker did not become active");
    if (pwaState.missing.length > 0) fail(`PWA cache is missing: ${pwaState.missing.join(", ")}`);

    await page.locator("#nickname").fill("Browser E2E Player");
    await page.locator("#session-token").fill(fixtureToken);
    await Promise.all([
      page.waitForURL(/\/web_game_run\.html(?:\?|$)/, { timeout: 5000 }),
      connectButton.click(),
    ]);
    if (await page.title() !== "BZFlag Web Client · Game") fail("Game page identity did not match the expected title");
    if (!(await page.locator("#game-canvas").isVisible())) fail("Game canvas is not visible after Connect");
    await page.locator("#connection-status").waitFor({ state: "visible", timeout: 5000 });
    await page.waitForFunction(
      () => window.__bzflagE2ePackets?.some((packet) => packet.code === 0x6163),
      undefined,
      { timeout: 5000 },
    );
    await page.waitForTimeout(500);
    const gameState = await page.evaluate(() => ({
      status: document.querySelector("#connection-status")?.textContent?.trim() || "",
      statusClass: document.querySelector("#connection-status")?.className || "",
      player: document.querySelector("#session-player")?.textContent?.trim() || "",
      renderer: document.querySelector("#renderer-label")?.textContent?.trim() || "",
      worldStateReady: Boolean(window.BZFlagWebGame?.worldState),
      protocolCodes: (window.__bzflagE2ePackets || []).map((packet) => packet.code),
    }));
    if (!/\bsuccess\b/i.test(gameState.statusClass)) fail(`Gateway did not reach connected state: ${gameState.status} (${gameState.statusClass})`);
    if (gameState.player !== "Browser E2E Player") fail(`Session player was not carried into the game page: ${gameState.player}`);
    if (!gameState.worldStateReady) fail("Client world state module did not load from the compiled dist path");
    if (fixture.state.upgradeCount !== 1) fail(`Fixture observed ${fixture.state.upgradeCount} WebSocket upgrades; expected exactly one`);
    if (!fixture.state.gatewayHandshakeReceived) fail("Fixture did not expose a validated BZFS handshake");
    if (fixture.state.enterPackets < 1) fail("Fixture did not receive a BZFlag MsgEnter packet");
    if (fixture.state.enterNickname !== "Browser E2E Player") fail(`Fixture received an unexpected callsign: ${fixture.state.enterNickname || "<empty>"}`);
    if (fixture.state.acceptSent < 1) fail("Fixture did not send a BZFlag MsgAccept packet");
    if (!gameState.protocolCodes.includes(MSG_ACCEPT)) fail("Client did not consume the fixture's BZFlag MsgAccept packet");
    if (fixture.state.binaryMessages < 1) fail("Fixture did not receive any binary BZWB message");
    if (fixture.state.errors.length > 0) fail(`Fixture reported protocol errors: ${fixture.state.errors.join("; ")}`);
    if (consoleMessages.length > 0) fail(`Browser console reported errors or warnings: ${consoleMessages.join("; ")}`);
    if (requestFailures.length > 0) fail(`Browser requests failed: ${requestFailures.join("; ")}`);
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: false });

    console.log(JSON.stringify({
      entryUrl,
      gameUrl: page.url(),
      pwa: { active: pwaState.active, cachedAssets: pwaState.cached.length },
      game: gameState,
      fixture: {
        upgrades: fixture.state.upgradeCount,
        binaryMessages: fixture.state.binaryMessages,
        enterPackets: fixture.state.enterPackets,
        acceptSent: fixture.state.acceptSent,
        udpLinkRequests: fixture.state.udpLinkRequests,
      },
      screenshot: screenshotPath || null,
    }, null, 2));
  } finally {
    if (browser) await browser.close();
    await new Promise((resolveClose) => fixture.server.close(() => resolveClose()));
  }
}

try {
  await run();
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}

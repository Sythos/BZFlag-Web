/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Sythos (https://www.sythos.net)
 *
 * MIT License
 *
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
 * Interoperability smoke test: browser-facing WebSocket bridge -> real gateway
 * implementation -> a local BZFS 2.4.31 wire fixture. The fixture is
 * deliberately local and never turns the CI runner into an open proxy.
 */

import { randomBytes } from "node:crypto";
import { createServer, createConnection } from "node:net";
import { createSocket } from "node:dgram";

const { createGateway } = await import(new URL("../../server/dist/gateway.js", import.meta.url));

const BRIDGE_MAGIC = Buffer.from("BZWB", "ascii");
const BRIDGE_VERSION = 1;
const CHANNEL_TCP = 0;
const CHANNEL_UDP = 1;
const BZFLAG_CONNECT_HEADER = Buffer.from("BZFLAG\r\n\r\n", "ascii");
const BZFS_GREETING = Buffer.concat([Buffer.from("BZFS0221", "ascii"), Buffer.from([7])]);
const MSG_ACCEPT = 0x6163;
const MSG_ENTER = 0x656e;
const MSG_UDP_LINK_REQUEST = 0x6f66;
const MSG_UDP_LINK_ESTABLISHED = 0x6f67;
const SERVER_ID = "official-interoperability";
const SESSION_TOKEN = "bzflag-web-interoperability-token";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Fixture listener address is unavailable"));
      resolve(address.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

function bzflagPacket(code, payload = Buffer.alloc(0)) {
  const body = Buffer.from(payload);
  const packet = Buffer.alloc(4 + body.length);
  packet.writeUInt16BE(body.length, 0);
  packet.writeUInt16BE(code, 2);
  body.copy(packet, 4);
  return packet;
}

function bridgeEnvelope(channel, payload) {
  const envelope = Buffer.alloc(8);
  BRIDGE_MAGIC.copy(envelope, 0);
  envelope[4] = BRIDGE_VERSION;
  envelope[5] = channel;
  return Buffer.concat([envelope, Buffer.from(payload)]);
}

function maskedWebSocketFrame(payload, opcode = 2) {
  const body = Buffer.from(payload);
  const mask = Buffer.from([0x3a, 0x71, 0x29, 0x5f]);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const masked = Buffer.from(body);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function parseWebSocketFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const largeLength = buffer.readBigUInt64BE(2);
    if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Gateway frame is too large");
    length = Number(largeLength);
    offset = 10;
  }
  if (buffer.length < offset + length) return null;
  return {
    opcode: first & 0x0f,
    payload: buffer.subarray(offset, offset + length),
    rest: buffer.subarray(offset + length),
  };
}

function makeFrameQueue(socket, initial = Buffer.alloc(0)) {
  let buffer = Buffer.from(initial);
  let closed = false;
  const queued = [];
  const waiters = [];
  const deliver = (frame) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(frame);
    else queued.push(frame);
  };
  const parse = () => {
    while (true) {
      const frame = parseWebSocketFrame(buffer);
      if (!frame) return;
      buffer = frame.rest;
      deliver(frame);
    }
  };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    parse();
  });
  socket.once("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error("Gateway WebSocket closed"));
  });
  return {
    next(timeoutMs = 5000) {
      if (queued.length) return Promise.resolve(queued.shift());
      if (closed) return Promise.reject(new Error("Gateway WebSocket closed"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((entry) => entry.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Timed out waiting for a gateway frame"));
        }, timeoutMs);
        timer.unref?.();
        waiters.push({ resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      });
    },
  };
}

function packetFromBridgeFrame(frame) {
  assert(frame.opcode === 2, `Gateway returned unsupported WebSocket opcode ${frame.opcode}`);
  assert(frame.payload.length >= 8, "Gateway bridge frame is truncated");
  assert(frame.payload.subarray(0, 4).equals(BRIDGE_MAGIC), "Gateway bridge magic is invalid");
  assert(frame.payload[4] === BRIDGE_VERSION, "Gateway bridge version is invalid");
  assert(frame.payload[6] === 0 && frame.payload[7] === 0, "Gateway bridge reserved bytes are not zero");
  const channel = frame.payload[5];
  assert(channel === CHANNEL_TCP || channel === CHANNEL_UDP, "Gateway bridge channel is invalid");
  return { channel, payload: frame.payload.subarray(8) };
}

function packetCode(packet) {
  if (packet.length < 4) return null;
  const length = packet.readUInt16BE(0);
  if (length + 4 !== packet.length) return null;
  return packet.readUInt16BE(2);
}

async function startBzfsFixture() {
  const state = { connectHeader: false, enterPackets: 0, udpRequests: 0 };
  const tcp = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let greeted = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (!greeted) {
        if (buffer.length < BZFLAG_CONNECT_HEADER.length) return;
        assert(buffer.subarray(0, BZFLAG_CONNECT_HEADER.length).equals(BZFLAG_CONNECT_HEADER), "Gateway did not send the native BZFLAG probe");
        state.connectHeader = true;
        greeted = true;
        buffer = buffer.subarray(BZFLAG_CONNECT_HEADER.length);
        socket.write(BZFS_GREETING);
      }
      while (buffer.length >= 4) {
        const payloadLength = buffer.readUInt16BE(0);
        const packetLength = payloadLength + 4;
        if (buffer.length < packetLength) return;
        const packet = buffer.subarray(0, packetLength);
        buffer = buffer.subarray(packetLength);
        const code = packetCode(packet);
        if (code === MSG_ENTER) {
          state.enterPackets += 1;
          socket.write(bzflagPacket(MSG_ACCEPT));
        }
      }
    });
  });
  const targetPort = await listen(tcp);
  const udp = createSocket("udp4");
  await new Promise((resolve, reject) => {
    udp.once("error", reject);
    udp.bind(targetPort, "127.0.0.1", () => {
      udp.off("error", reject);
      resolve();
    });
  });
  udp.on("message", (message, remote) => {
    if (packetCode(message) !== MSG_UDP_LINK_REQUEST) return;
    state.udpRequests += 1;
    const reply = bzflagPacket(MSG_UDP_LINK_ESTABLISHED);
    udp.send(reply, remote.port, remote.address);
  });
  return {
    state,
    targetPort,
    async close() {
      udp.close();
      await closeServer(tcp);
    },
  };
}

async function run() {
  const fixture = await startBzfsFixture();
  const gateway = createGateway({
    host: "127.0.0.1",
    port: 0,
    sessionToken: SESSION_TOKEN,
    allowLegacyQueryToken: false,
    allowPrivateAddresses: true,
    allowedOrigins: ["http://127.0.0.1"],
    servers: [{ id: SERVER_ID, host: "127.0.0.1", port: fixture.targetPort, udpPort: fixture.targetPort, kind: "official", enabled: true }],
  });
  let socket;
  try {
    const address = await gateway.start();
    socket = createConnection({ host: "127.0.0.1", port: address.port });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const tokenProtocol = `bzflag-token.${Buffer.from(SESSION_TOKEN, "utf8").toString("base64url")}`;
    // RFC 6455 requires a fresh base64-encoded 16-byte nonce for each upgrade.
    const websocketKey = randomBytes(16).toString("base64");
    socket.write([
      `GET /bridge?server=${SERVER_ID} HTTP/1.1`,
      "Host: 127.0.0.1",
      "Origin: http://127.0.0.1",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${websocketKey}`,
      `Sec-WebSocket-Protocol: bzflag-web-v1, ${tokenProtocol}`,
      "",
      "",
    ].join("\r\n"));
    let httpBuffer = Buffer.alloc(0);
    const remainder = await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        httpBuffer = Buffer.concat([httpBuffer, Buffer.from(chunk)]);
        const marker = httpBuffer.indexOf("\r\n\r\n");
        if (marker < 0) return;
        socket.off("data", onData);
        resolve(httpBuffer.subarray(marker + 4));
      };
      socket.on("data", onData);
      socket.once("error", reject);
    });
    assert(httpBuffer.toString("ascii", 0, httpBuffer.indexOf("\r\n\r\n")).startsWith("HTTP/1.1 101"), "Gateway did not accept the authenticated WebSocket upgrade");
    const frames = makeFrameQueue(socket, remainder);
    let greeting = false;
    for (let attempt = 0; attempt < 3 && !greeting; attempt += 1) {
      const bridge = packetFromBridgeFrame(await frames.next());
      if (bridge.channel === CHANNEL_TCP && bridge.payload.equals(BZFS_GREETING)) greeting = true;
    }
    assert(greeting, "Gateway did not relay the validated BZFS 2.4.31 greeting");
    socket.write(maskedWebSocketFrame(bridgeEnvelope(CHANNEL_TCP, bzflagPacket(MSG_ENTER))));
    let accepted = false;
    for (let attempt = 0; attempt < 5 && !accepted; attempt += 1) {
      const bridge = packetFromBridgeFrame(await frames.next());
      if (bridge.channel === CHANNEL_TCP && packetCode(bridge.payload) === MSG_ACCEPT) accepted = true;
    }
    assert(accepted, "Gateway did not relay the BZFS MsgAccept packet");
    socket.write(maskedWebSocketFrame(bridgeEnvelope(CHANNEL_UDP, bzflagPacket(MSG_UDP_LINK_REQUEST, Buffer.from([7])))));
    let udpEstablished = false;
    for (let attempt = 0; attempt < 5 && !udpEstablished; attempt += 1) {
      const bridge = packetFromBridgeFrame(await frames.next());
      if (bridge.channel === CHANNEL_UDP && packetCode(bridge.payload) === MSG_UDP_LINK_ESTABLISHED) udpEstablished = true;
    }
    assert(udpEstablished, "Gateway did not relay the BZFS UDP link response");
    assert(fixture.state.connectHeader && fixture.state.enterPackets === 1 && fixture.state.udpRequests === 1, "BZFS fixture did not observe the expected native TCP/UDP exchange");
    console.log("BZFS interoperability smoke passed (native greeting, MsgAccept and UDP link through the gateway).");
  } finally {
    socket?.destroy();
    await gateway.stop();
    await fixture.close();
  }
}

try {
  await run();
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}

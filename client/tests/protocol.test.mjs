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
 */

import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const distPath = fileURLToPath(new URL("../dist/protocol.js", import.meta.url));
const source = await readFile(distPath, "utf8");
const events = [];
const context = {
  ArrayBuffer,
  ArrayBufferView: undefined,
  DataView,
  TextDecoder,
  TextEncoder,
  Uint8Array,
  CustomEvent: class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  },
  document: {
    dispatchEvent(event) {
      events.push(event);
    },
    getElementById() {
      return null;
    }
  },
  window: {}
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "dist/protocol.js" });
const protocol = context.window.BZFlagWebProtocol;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function packetCode(packet) {
  return new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint16(2);
}

function packetLength(packet) {
  return new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint16(0);
}

const enter = protocol.encodeEnter({
  nickname: "Web Pilot",
  motto: "relative gateway",
  team: "red",
  sessionToken: "gateway-only-token",
  bzfsToken: "bzfs-token"
});
assert(enter.byteLength === 4 + protocol.ENTER_PAYLOAD_BYTES, "enter packet has an unexpected size");
assert(packetCode(enter) === protocol.MSG_ENTER, "enter packet has an unexpected code");
assert(packetLength(enter) === protocol.ENTER_PAYLOAD_BYTES, "enter packet length header is invalid");
const enterView = new DataView(enter.buffer);
assert(enterView.getUint16(4) === 0, "enter packet must request a tank player");
assert(enterView.getInt16(6) === protocol.TEAM_BY_NAME.red, "enter team is not encoded in network order");
const enterBytes = new Uint8Array(enter.buffer, 4);
const tokenOffset = 4 + protocol.CALLSIGN_BYTES + protocol.MOTTO_BYTES;
const tokenText = new TextDecoder().decode(enterBytes.slice(tokenOffset, tokenOffset + protocol.TOKEN_BYTES));
assert(tokenText.startsWith("bzfs-token"), "explicit BZFS token was not encoded");
assert(!tokenText.includes("gateway-only-token"), "gateway bearer token leaked into BZFlag enter data");

const stream = new protocol.PacketStream({ maxBytes: 64, maxPacketsPerPush: 4 });
const accept = protocol.encodePacket(protocol.MSG_ACCEPT);
const alive = protocol.encodePacket(protocol.MSG_ALIVE);
assert(stream.push(accept.slice(0, 2)).length === 0, "partial packet should remain buffered");
const first = stream.push(new Uint8Array([...accept.slice(2), ...alive]));
assert(first.length === 2, "stream did not reassemble and split concatenated packets");
assert(stream.bufferedBytes === 0, "stream retained bytes after complete packets");
assert(protocol.readPacketCode(first[0]).code === protocol.MSG_ACCEPT, "stream returned a corrupt packet");
assert(protocol.readPacketCode(new Uint8Array([0, 0, 0])) === null, "incomplete header must not decode");

const movement = protocol.encodePlayerUpdate({
  playerId: 7,
  order: 13,
  status: protocol.PLAYER_STATUS.alive,
  timestamp: 1.25,
  position: [1, 2, 3],
  velocity: [4, 5, 6],
  azimuth: 0.5,
  angularVelocity: 0.1
});
assert(movement && packetCode(movement) === protocol.MSG_PLAYER_UPDATE, "movement was not encoded as MsgPlayerUpdate");
assert(packetLength(movement) === 43, "full player update has an unexpected payload size");
const movementView = new DataView(movement.buffer);
assert(movementView.getUint8(8) === 7, "player id is not encoded in player update");
assert(movementView.getInt32(9) === 13, "player order is not encoded in player update");
assert(protocol.encodeInput("move-forward", "start") === null, "movement without authoritative state must be suppressed");
assert(protocol.encodeInput("move-forward", "start", "KeyW", { playerId: 7, order: 14 }) !== null, "bounded movement encoder rejected valid state");

const shot = protocol.encodeShotBegin({
  playerId: 7,
  shotId: 3,
  position: [0, 1, 2],
  velocity: [10, 0, 0],
  team: protocol.TEAM_BY_NAME.red,
  flag: "SW",
  lifetime: 3
});
assert(shot && packetCode(shot) === protocol.MSG_SHOT_BEGIN, "shot was not encoded as MsgShotBegin");
assert(packetLength(shot) === protocol.FIRE_PAYLOAD_BYTES, "shot payload is not FiringInfo-sized");
assert(protocol.encodeInput("fire", "start") === null, "fire without firing state must be suppressed");
assert(protocol.encodeInput("drop-flag", "start") === null, "drop flag without position must be suppressed");
const aliveInput = protocol.encodeInput("alive", "start");
assert(aliveInput && packetCode(aliveInput) === protocol.MSG_ALIVE, "alive packet was not produced");

const addBody = new Uint8Array(protocol.ADD_PLAYER_PAYLOAD_BYTES);
const addView = new DataView(addBody.buffer);
addView.setUint8(0, 19);
addView.setUint16(1, 0);
addView.setInt16(3, protocol.TEAM_BY_NAME.blue);
addBody.set(new TextEncoder().encode("Web Pilot"), 5);
const add = protocol.encodePacket(protocol.MSG_ADD_PLAYER, addBody);
const detail = protocol.consume(0, add, { nickname: "Web Pilot" });
assert(detail.local === true && detail.player.playerId === 19, "MsgAddPlayer local player was not decoded");
assert(events.length === 1 && events[0].type === "bzflag:packet", "protocol event was not dispatched");

let bounded = false;
try {
  protocol.encodePacket(protocol.MSG_MESSAGE, new Uint8Array(protocol.MAX_PACKET_BYTES));
} catch {
  bounded = true;
}
assert(bounded, "oversized BZFlag payload was not rejected");

console.log("Client protocol checks passed (bounded packets, stream reassembly, native input layouts).");

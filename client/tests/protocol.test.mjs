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
const { createWorldState } = await import("../dist/state.js");

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

const connectHeader = protocol.encodeConnectHeader();
assert(new TextDecoder().decode(connectHeader) === "BZFLAG\r\n\r\n", "BZFlag connect header is not native-compatible");
const handshake = new protocol.ServerHandshake();
const greeting = new Uint8Array(9 + accept.byteLength);
greeting.set(new TextEncoder().encode("BZFS0221"), 0);
greeting[8] = 7;
greeting.set(accept, 9);
assert(handshake.push(greeting.slice(0, 3)).ready === false, "fragmented BZFS greeting completed too early");
const completedHandshake = handshake.push(greeting.slice(3));
assert(completedHandshake.ready && completedHandshake.version === "BZFS0221", "BZFS greeting was not validated");
assert(completedHandshake.playerId === 7, "BZFS greeting did not expose the assigned player ID");
assert(protocol.readPacketCode(completedHandshake.payload).code === protocol.MSG_ACCEPT, "handshake did not retain the first BZFlag packet");
let incompatibleVersion = false;
try {
  new protocol.ServerHandshake().push(new TextEncoder().encode("BZFS9999"));
} catch {
  incompatibleVersion = true;
}
assert(incompatibleVersion, "incompatible BZFS versions were not rejected");

const outgoingMessage = protocol.encodeMessage(protocol.ALL_PLAYERS, "hello from browser");
assert(packetCode(outgoingMessage) === protocol.MSG_MESSAGE, "outgoing MsgMessage has an unexpected code");
assert(packetLength(outgoingMessage) === protocol.MESSAGE_OUTGOING_PAYLOAD_BYTES, "outgoing MsgMessage has the wrong native payload size");
assert(packetLength(outgoingMessage) === 129, "outgoing MsgMessage must contain one destination byte and 128 message bytes");

const flagNegotiation = protocol.encodeFlagNegotiation();
assert(packetCode(flagNegotiation) === protocol.MSG_NEGOTIATE_FLAGS, "flag negotiation packet has an unexpected code");
assert(packetLength(flagNegotiation) === protocol.FLAG_ABBREVIATIONS.length * 2, "flag negotiation packet has an unexpected payload size");
const missingFlags = protocol.decodeFlagNegotiation(new Uint8Array([0x53, 0x57, 0x00, 0x52]));
assert(missingFlags?.missing && missingFlags.flags[0] === "SW", "server flag negotiation response was not decoded");
const worldPayload = new Uint8Array(7);
new DataView(worldPayload.buffer).setUint32(0, 2);
worldPayload.set([0x01, 0x02, 0x03], 4);
const worldChunk = protocol.decodeWorldChunk(worldPayload);
assert(worldChunk?.bytesLeft === 2 && worldChunk.chunkBytes === 3, "world transfer chunk was not decoded");
const worldRequest = protocol.encodeGetWorld(256);
assert(packetCode(worldRequest) === protocol.MSG_GET_WORLD && packetLength(worldRequest) === 4, "world transfer request was not encoded");
assert(packetCode(protocol.encodeUDPLinkRequest(7)) === protocol.MSG_UDP_LINK_REQUEST, "UDP link request was not encoded");
assert(packetCode(protocol.encodeUDPLinkEstablished()) === protocol.MSG_UDP_LINK_ESTABLISHED, "UDP link confirmation was not encoded");

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
addView.setUint16(3, protocol.TEAM_BY_NAME.blue);
addView.setUint16(5, 12);
addView.setUint16(7, 4);
addView.setUint16(9, 1);
addBody.set(new TextEncoder().encode("Web Pilot"), 11);
const add = protocol.encodePacket(protocol.MSG_ADD_PLAYER, addBody);
const detail = protocol.consume(0, add, { nickname: "Web Pilot" });
assert(detail.local === true && detail.player.playerId === 19, "MsgAddPlayer local player was not decoded");
assert(detail.player.wins === 12 && detail.player.losses === 4 && detail.player.tks === 1, "MsgAddPlayer score fields were not decoded");
assert(events.at(-1).type === "bzflag:packet", "protocol event was not dispatched");

const decodedMovement = protocol.decodePlayerUpdate(protocol.readPacketCode(movement).payload, false);
assert(decodedMovement.playerId === 7 && decodedMovement.position[2] === 3, "full MsgPlayerUpdate was not decoded");
const smallBody = new Uint8Array(27);
const smallView = new DataView(smallBody.buffer);
smallView.setFloat32(0, 2.5);
smallView.setUint8(4, 7);
smallView.setInt32(5, 15);
smallView.setInt16(9, protocol.PLAYER_STATUS.alive);
for (let index = 0; index < 8; index += 1) smallView.setInt16(11 + index * 2, index + 1);
const smallPacket = protocol.encodePacket(protocol.MSG_PLAYER_UPDATE_SMALL, smallBody);
const decodedSmall = protocol.decodePlayerUpdate(protocol.readPacketCode(smallPacket).payload, true);
assert(decodedSmall.small && decodedSmall.order === 15 && decodedSmall.position[0] === 0.02, "small MsgPlayerUpdate was not decoded");
assert(protocol.decodePlayerUpdate(new Uint8Array(3), true) === null, "truncated player update was accepted");

const shotDetail = protocol.consume(0, shot);
assert(shotDetail.data.shotId === 3 && shotDetail.data.flag === "SW", "MsgShotBegin was not decoded");
const shotEndBody = new Uint8Array(protocol.SHOT_END_PAYLOAD_BYTES);
const shotEndView = new DataView(shotEndBody.buffer);
shotEndView.setUint8(0, 7);
shotEndView.setInt16(1, 3);
shotEndView.setUint16(3, 2);
const shotEnd = protocol.encodePacket(protocol.MSG_SHOT_END, shotEndBody);
assert(protocol.consume(0, shotEnd).data.shotId === 3, "MsgShotEnd was not decoded");

const flagBody = new Uint8Array(2 + 2 + protocol.FLAG_PAYLOAD_BYTES);
const flagView = new DataView(flagBody.buffer);
flagView.setUint16(0, 1);
flagView.setUint16(2, 5);
flagBody.set(new TextEncoder().encode("SW"), 4);
flagView.setUint16(6, 1);
flagView.setUint16(8, 2);
flagView.setUint8(10, 7);
for (let offset = 11; offset < 47; offset += 4) flagView.setFloat32(offset, offset / 10);
flagView.setFloat32(47, 1);
flagView.setFloat32(51, 2);
flagView.setFloat32(55, 3);
const flagPacket = protocol.encodePacket(protocol.MSG_FLAG_UPDATE, flagBody);
assert(protocol.consume(0, flagPacket).data.flags[0].flagIndex === 5, "MsgFlagUpdate was not decoded");
assert(protocol.decodeFlagUpdate(new Uint8Array([0, 2])) === null, "incomplete MsgFlagUpdate was accepted");

const messageBody = new Uint8Array(protocol.MESSAGE_PAYLOAD_BYTES);
messageBody[0] = 7;
messageBody[1] = protocol.ALL_PLAYERS;
messageBody[2] = 0;
messageBody.set(new TextEncoder().encode("hello from server"), protocol.MESSAGE_SERVER_HEADER_BYTES);
const messagePacket = protocol.encodePacket(protocol.MSG_MESSAGE, messageBody);
const decodedMessage = protocol.consume(0, messagePacket).data;
assert(decodedMessage.message === "hello from server" && decodedMessage.type === 0, "MsgMessage was not decoded");
const aliveBody = new Uint8Array(protocol.ALIVE_PAYLOAD_BYTES);
const aliveView = new DataView(aliveBody.buffer);
aliveBody[0] = 7;
aliveView.setFloat32(1, 10);
aliveView.setFloat32(5, 11);
aliveView.setFloat32(9, 12);
aliveView.setFloat32(13, 1.5);
const alivePacket = protocol.encodePacket(protocol.MSG_ALIVE, aliveBody);
assert(protocol.consume(0, alivePacket).data.azimuth === 1.5, "MsgAlive was not decoded");
const rejectBody = new Uint8Array(2 + protocol.MESSAGE_BYTES);
new DataView(rejectBody.buffer).setUint16(0, 6);
rejectBody.set(new TextEncoder().encode("callsign rejected"), 2);
const rejectPacket = protocol.encodePacket(protocol.MSG_REJECT, rejectBody);
assert(protocol.consume(0, rejectPacket).data.reasonCode === 6, "MsgReject was not decoded");

const world = createWorldState({ players: 2, shots: 2, flags: 2, messages: 2 });
assert(world.apply(protocol.consume(0, protocol.encodePacket(protocol.MSG_ACCEPT))).applied, "WorldState did not accept MsgAccept");
assert(world.apply(detail).localPlayerId === 19, "WorldState did not register local player");
assert(world.apply(protocol.consume(0, alivePacket)).applied, "WorldState did not apply MsgAlive");
assert(world.apply(shotDetail).applied && world.shots.size === 1, "WorldState did not add shot");
assert(world.apply(protocol.consume(0, flagPacket)).applied && world.flags.size === 1, "WorldState did not add flag");
assert(world.apply(protocol.consume(0, messagePacket)).applied && world.messages.length === 1, "WorldState did not add message");
assert(world.apply(protocol.consume(0, shotEnd)).applied && world.shots.size === 0, "WorldState did not remove shot");
const remove = protocol.encodePacket(protocol.MSG_REMOVE_PLAYER, new Uint8Array([19]));
assert(world.apply(protocol.consume(0, remove)).applied && world.localPlayerId === null, "WorldState did not remove player");
assert(world.apply(protocol.consume(0, rejectPacket)).applied && world.connection.phase === "rejected", "WorldState did not apply rejection");

let bounded = false;
try {
  protocol.encodePacket(protocol.MSG_MESSAGE, new Uint8Array(protocol.MAX_PACKET_BYTES));
} catch {
  bounded = true;
}
assert(bounded, "oversized BZFlag payload was not rejected");

console.log("Client protocol checks passed (bounded packets, stream reassembly, native input layouts).");

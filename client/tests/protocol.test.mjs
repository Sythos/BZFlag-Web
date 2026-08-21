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
const restartInput = protocol.encodeInput("restart", "end");
assert(restartInput && packetCode(restartInput) === protocol.MSG_ALIVE, "native restart release did not produce MsgAlive");
assert(protocol.encodeInput("restart", "start") === null, "native restart fired before key release");

const nativeShotEnd = protocol.encodeShotEnd({ playerId: 7, shotId: -3, reason: 2 });
assert(nativeShotEnd && packetCode(nativeShotEnd) === protocol.MSG_SHOT_END, "shot end was not encoded as MsgShotEnd");
assert(packetLength(nativeShotEnd) === protocol.SHOT_END_PAYLOAD_BYTES, "shot end payload has an unexpected size");
assert(protocol.encodeInput("shot-end", "start", "", { playerId: 7, shotId: 3, reason: 1 }), "shot-end input was not routed");
assert(protocol.encodeShotEnd({ playerId: protocol.NO_PLAYER, shotId: 1, reason: 0 }) === null, "reserved player ID was accepted for shot end");

const capture = protocol.encodeCaptureFlag("red");
assert(capture && packetCode(capture) === protocol.MSG_CAPTURE_FLAG, "capture flag was not encoded as MsgCaptureFlag");
assert(new DataView(capture.buffer).getUint16(4) === protocol.TEAM_BY_NAME.red, "capture team was not encoded in network order");
assert(protocol.encodeInput("capture-flag", "start", "", { team: "blue" }), "capture input was not routed");
const transfer = protocol.encodeTransferFlag(7, protocol.SERVER_PLAYER);
assert(transfer && packetCode(transfer) === protocol.MSG_TRANSFER_FLAG, "flag transfer was not encoded as MsgTransferFlag");
assert(packetLength(transfer) === protocol.TRANSFER_FLAG_PAYLOAD_BYTES, "flag transfer payload has an unexpected size");
assert(protocol.encodeTransferFlag(7, protocol.NO_PLAYER) === null, "reserved player ID was accepted for flag transfer");
const localTransfer = protocol.encodeInput("transfer-flag", "start", "", { playerId: 7, from: 7, to: protocol.SERVER_PLAYER });
assert(localTransfer && new DataView(localTransfer.buffer).getUint8(4) === 7, "flag transfer did not use the local player ID");
assert(protocol.encodeInput("transfer-flag", "start", "", { playerId: 7, from: 8, to: protocol.SERVER_PLAYER }) === null, "arbitrary flag transfer source was accepted");
const teleport = protocol.encodeTeleport(0, 0xffff);
assert(teleport && packetCode(teleport) === protocol.MSG_TELEPORT, "teleport was not encoded as MsgTeleport");
assert(protocol.encodeTeleport(-1, 2) === null, "negative teleport index was accepted");
assert(packetCode(protocol.encodeNewRabbit()) === protocol.MSG_NEW_RABBIT, "new-rabbit command was not encoded");
assert(new DataView(protocol.encodeAutoPilot(true).buffer).getUint8(4) === 1, "autopilot enable flag was not encoded");

const teamMessage = protocol.encodeInput("send-team", "start", "KeyM", { team: "red", message: "team hello" });
assert(teamMessage && packetCode(teamMessage) === protocol.MSG_MESSAGE, "native team chat was not encoded");
assert(new DataView(teamMessage.buffer).getUint8(4) === protocol.FIRST_TEAM - protocol.TEAM_BY_NAME.red, "team chat target was not derived from the native team address");
const adminMessage = protocol.encodeInput("send-admin", "start", "KeyZ", { message: "admin hello" });
assert(adminMessage && new DataView(adminMessage.buffer).getUint8(4) === protocol.ADMIN_PLAYERS, "admin chat target was not encoded");
assert(protocol.encodeInput("chat", "start", "", { message: "" }) === null, "empty chat message was accepted");
assert(protocol.encodeInput("send-recipient", "start", "", { target: protocol.NO_PLAYER, message: "invalid" }) === null, "invalid chat target was accepted");

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
const superKill = protocol.encodePacket(protocol.MSG_SUPER_KILL);
assert(protocol.decodePacketData(protocol.MSG_SUPER_KILL, new Uint8Array()) !== null, "empty MsgSuperKill was not decoded");
assert(protocol.consume(0, superKill).data && packetLength(superKill) === 0, "MsgSuperKill no-payload packet was not decoded");
assert(protocol.decodePacketData(protocol.MSG_SUPER_KILL, new Uint8Array([1])) === null, "MsgSuperKill accepted an unexpected payload");

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

function createFlagRecord(abbreviation = "SW") {
  const body = new Uint8Array(protocol.FLAG_PAYLOAD_BYTES);
  const view = new DataView(body.buffer);
  body.set(new TextEncoder().encode(abbreviation), 0);
  view.setUint16(2, 1);
  view.setUint16(4, 0);
  view.setUint8(6, 7);
  view.setFloat32(7, 1);
  view.setFloat32(11, 2);
  view.setFloat32(15, 3);
  view.setFloat32(19, 4);
  view.setFloat32(23, 5);
  view.setFloat32(27, 6);
  view.setFloat32(31, 7);
  view.setFloat32(35, 8);
  view.setFloat32(39, 9);
  view.setFloat32(43, 1.5);
  view.setFloat32(47, 2.5);
  view.setFloat32(51, 3.5);
  return body;
}

const teamBody = new Uint8Array(1 + 2 * protocol.TEAM_RECORD_BYTES);
const teamView = new DataView(teamBody.buffer);
teamBody[0] = 2;
teamView.setUint16(1, protocol.TEAM_BY_NAME.red);
teamView.setUint16(3, 4);
teamView.setUint16(5, 8);
teamView.setUint16(7, 2);
teamView.setUint16(9, protocol.TEAM_BY_NAME.blue);
teamView.setUint16(11, 5);
teamView.setUint16(13, 9);
teamView.setUint16(15, 3);
const teamUpdate = protocol.encodePacket(protocol.MSG_TEAM_UPDATE, teamBody);
const decodedTeams = protocol.consume(0, teamUpdate).data;
assert(decodedTeams.count === 2 && decodedTeams.teams[0].wins === 8, "MsgTeamUpdate was not decoded");
assert(protocol.decodeTeamUpdate(teamBody.slice(0, -1)) === null, "truncated MsgTeamUpdate was accepted");
teamView.setUint16(1, 8);
assert(protocol.decodeTeamUpdate(teamBody) === null, "unknown team index was accepted");
teamView.setUint16(1, protocol.TEAM_BY_NAME.red);

const killedBody = new Uint8Array(protocol.KILLED_SERVER_PAYLOAD_BYTES);
const killedView = new DataView(killedBody.buffer);
killedBody[0] = 7;
killedBody[1] = protocol.SERVER_PLAYER;
killedView.setInt16(2, 0x1234);
killedView.setInt16(4, -3);
killedBody.set(new TextEncoder().encode("SW"), 6);
const killedPacket = protocol.encodePacket(protocol.MSG_KILLED, killedBody);
const killed = protocol.consume(0, killedPacket).data;
assert(killed.victim === 7 && killed.killer === protocol.SERVER_PLAYER && killed.flagType === "SW", "MsgKilled was not decoded");
const noKillerBody = killedBody.slice();
noKillerBody[1] = protocol.NO_PLAYER;
assert(protocol.decodeKilled(noKillerBody)?.killer === protocol.NO_PLAYER, "MsgKilled rejected the native NoPlayer killer");
const killedPhysicsBody = new Uint8Array(protocol.KILLED_SERVER_PAYLOAD_BYTES + protocol.KILLED_PHYSICS_DRIVER_BYTES);
killedPhysicsBody.set(killedBody);
const killedPhysicsView = new DataView(killedPhysicsBody.buffer);
killedPhysicsView.setInt16(2, protocol.PHYSICS_DRIVER_DEATH);
killedPhysicsView.setInt32(protocol.KILLED_SERVER_PAYLOAD_BYTES, 12);
const killedPhysics = protocol.decodeKilled(killedPhysicsBody);
assert(killedPhysics?.physicsDriver === 12, "physics-driver MsgKilled payload was not decoded");
assert(protocol.decodeKilled(killedBody.slice(0, -1)) === null, "truncated MsgKilled was accepted");
assert(protocol.decodeKilled(new Uint8Array([...killedBody, 0])) === null, "unexpected MsgKilled bytes were accepted");
const killedOutgoing = protocol.encodeKilled({ killer: protocol.SERVER_PLAYER, reason: 0x1234, shotId: -3, flag: "SW" });
assert(killedOutgoing && packetLength(killedOutgoing) === protocol.KILLED_OUTGOING_PAYLOAD_BYTES, "outgoing MsgKilled has an unexpected size");
const environmentalKilled = protocol.encodeKilled({ killer: protocol.NO_PLAYER, reason: 0, shotId: -1, flag: "" });
assert(environmentalKilled && packetLength(environmentalKilled) === protocol.KILLED_OUTGOING_PAYLOAD_BYTES, "environmental MsgKilled did not accept the native NoPlayer killer");
const killedOutgoingPhysics = protocol.encodeKilled({ killer: 7, reason: protocol.PHYSICS_DRIVER_DEATH, shotId: -1, flag: "", physicsDriver: 3 });
assert(killedOutgoingPhysics && packetLength(killedOutgoingPhysics) === protocol.KILLED_OUTGOING_PAYLOAD_BYTES + protocol.KILLED_PHYSICS_DRIVER_BYTES, "physics-driver MsgKilled was not encoded");
assert(protocol.encodeKilled({ killer: 7, reason: 0, shotId: 0, flag: "?" }) === null, "invalid flag abbreviation was accepted in MsgKilled");

const eventFlag = createFlagRecord("SW");
const grabBody = new Uint8Array(protocol.FLAG_EVENT_SERVER_PAYLOAD_BYTES);
const grabView = new DataView(grabBody.buffer);
grabBody[0] = 7;
grabView.setUint16(1, 5);
grabBody.set(eventFlag, 3);
const grab = protocol.decodeGrabFlag(grabBody);
assert(grab?.playerId === 7 && grab.flagIndex === 5 && grab.flagType === "SW" && grab.position[2] === 3, "server MsgGrabFlag was not decoded");
assert(protocol.decodeDropFlag(grabBody)?.flagIndex === 5, "server MsgDropFlag was not decoded");
assert(protocol.decodeGrabFlag(new Uint8Array([...grabBody, 0])) === null, "unexpected MsgGrabFlag bytes were accepted");

const captureBody = new Uint8Array(protocol.CAPTURE_FLAG_SERVER_PAYLOAD_BYTES);
const captureView = new DataView(captureBody.buffer);
captureBody[0] = 7;
captureView.setUint16(1, 5);
captureView.setUint16(3, protocol.TEAM_BY_NAME.red);
const captureEvent = protocol.decodeCaptureFlag(captureBody);
assert(captureEvent?.playerId === 7 && captureEvent.team === protocol.TEAM_BY_NAME.red, "server MsgCaptureFlag was not decoded");
captureView.setUint16(3, 8);
assert(protocol.decodeCaptureFlag(captureBody) === null, "unknown capture team was accepted");
captureView.setUint16(3, protocol.TEAM_BY_NAME.red);

const teleportBody = new Uint8Array(protocol.TELEPORT_SERVER_PAYLOAD_BYTES);
const teleportView = new DataView(teleportBody.buffer);
teleportBody[0] = 7;
teleportView.setUint16(1, 2);
teleportView.setUint16(3, 4);
assert(protocol.decodeTeleport(teleportBody).to === 4, "server MsgTeleport was not decoded");
assert(protocol.decodeTeleport(teleportBody.slice(0, -1)) === null, "truncated MsgTeleport was accepted");

const transferBody = new Uint8Array(protocol.TRANSFER_FLAG_SERVER_PAYLOAD_BYTES);
transferBody[0] = 7;
transferBody[1] = protocol.SERVER_PLAYER;
transferBody.set(eventFlag, 2);
const transferEvent = protocol.decodeTransferFlag(transferBody);
assert(transferEvent?.from === 7 && transferEvent.to === protocol.SERVER_PLAYER && transferEvent.flagType === "SW", "server MsgTransferFlag was not decoded");
assert(protocol.decodeTransferFlag(new Uint8Array([...transferBody, 0])) === null, "unexpected MsgTransferFlag bytes were accepted");

const pauseBody = new Uint8Array([7, 1]);
assert(protocol.decodePause(pauseBody).paused === true, "server MsgPause was not decoded");
assert(protocol.decodeAutoPilot(new Uint8Array([7, 0])).enabled === false, "server MsgAutoPilot was not decoded");
assert(protocol.decodePause(new Uint8Array([7, 2])) === null, "invalid MsgPause boolean was accepted");
assert(protocol.decodeNewRabbit(new Uint8Array([7])).playerId === 7, "server MsgNewRabbit was not decoded");

const scoreBody = new Uint8Array(1 + 2 * protocol.SCORE_RECORD_BYTES);
const scoreView = new DataView(scoreBody.buffer);
scoreBody[0] = 2;
scoreBody[1] = 7;
scoreView.setUint16(2, 12);
scoreView.setUint16(4, 3);
scoreView.setUint16(6, 1);
scoreBody[8] = protocol.SERVER_PLAYER;
scoreView.setUint16(9, 20);
scoreView.setUint16(11, 5);
scoreView.setUint16(13, 2);
const score = protocol.decodeScore(scoreBody);
assert(score?.count === 2 && score.scores[1].wins === 20, "MsgScore was not decoded");
assert(protocol.decodeScore(scoreBody.slice(0, -1)) === null, "truncated MsgScore was accepted");
const scoreOver = protocol.decodeScoreOver(new Uint8Array([7, 0xff, 0xff]));
assert(scoreOver?.team === 0xffff, "player-winning MsgScoreOver was not decoded");
const timeView = new DataView(new ArrayBuffer(protocol.TIME_UPDATE_PAYLOAD_BYTES));
timeView.setInt32(0, -1);
assert(protocol.decodeTimeUpdate(new Uint8Array(timeView.buffer)).timeLeft === -1, "paused MsgTimeUpdate was not decoded");

const unknownDetail = protocol.consume(0, protocol.encodePacket(0xffff));
assert(unknownDetail.valid === false && unknownDetail.data === undefined, "unknown packet code was not rejected");

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

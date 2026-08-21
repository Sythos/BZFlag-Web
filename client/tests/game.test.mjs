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

const source = await readFile(fileURLToPath(new URL("../dist/game.js", import.meta.url)), "utf8");
const listeners = new Map();
const windowListeners = new Map();
const context = {
  ArrayBuffer,
  DataView,
  TextDecoder,
  TextEncoder,
  Uint8Array,
  document: {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    getElementById() {
      return null;
    }
  },
  window: {
    BZFlagWebI18n: { t: (key) => key },
    BZFlagWebProtocol: null,
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    removeEventListener(type) {
      windowListeners.delete(type);
    }
  }
};
class FakeWebSocket {}
FakeWebSocket.OPEN = 1;
context.WebSocket = FakeWebSocket;
context.HTMLInputElement = class HTMLInputElement {};
context.HTMLTextAreaElement = class HTMLTextAreaElement {};
context.HTMLSelectElement = class HTMLSelectElement {};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "dist/game.js" });

const game = context.window.BZFlagWebGame;
const protocol = {
  ALL_PLAYERS: 254,
  ADMIN_PLAYERS: 252,
  FIRST_TEAM: 251,
  MSG_SUPER_KILL: 0x736b,
  TEAM_BY_NAME: { red: 1 },
  encodeInput(command, phase, key, state) {
    calls.push({ command, phase, key, state });
    return new Uint8Array([0xaa, 0xbb]);
  }
};
const calls = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(game && typeof game.sendChatMessage === "function", "chat sender was not exposed by the game client");
assert(game.resolveChatTarget("all", { team: "red" }, protocol) === 254, "broadcast chat target was not resolved");
assert(game.resolveChatTarget("team", { team: "red" }, protocol) === 250, "team chat target was not resolved");
assert(game.resolveChatTarget("admin", { team: "red" }, protocol) === 252, "admin chat target was not resolved");
assert(game.resolveChatTarget("team", { team: "automatic" }, protocol) === null, "automatic team target must stay bounded until a team is known");

const frames = [];
const socket = { readyState: FakeWebSocket.OPEN, send(frame) { frames.push(frame); } };
assert(game.sendChatMessage(socket, protocol, { team: "red" }, "all", "hello from the composer"), "chat message was not sent");
assert(calls.length === 1, "chat sender did not call protocol.encodeInput exactly once");
assert(calls[0].command === "message" && calls[0].phase === "start", "chat sender used the wrong protocol input phase");
assert(calls[0].state.message === "hello from the composer" && calls[0].state.target === 254, "chat state did not provide message and target");
const frame = new Uint8Array(frames[0]);
assert(Array.from(frame.slice(0, 8)).join(",") === "66,90,87,66,1,0,0,0", "chat message was not wrapped in the TCP bridge envelope");
assert(Array.from(frame.slice(8)).join(",") === "170,187", "chat bridge envelope changed the encoded protocol payload");

assert(!game.sendChatMessage(socket, protocol, { team: "red" }, "all", "   "), "empty chat message was sent");
assert(!game.sendChatMessage(socket, protocol, { team: "automatic" }, "team", "not ready"), "unresolved team chat target was sent");
assert(!game.sendChatMessage(socket, protocol, { team: "red" }, "all", "x".repeat(129)), "oversized chat message was sent");
assert(frames.length === 1 && calls.length === 1, "invalid chat submissions reached the protocol or socket");
assert(listeners.has("DOMContentLoaded"), "game client did not retain its DOMContentLoaded bootstrap");

assert(game.resolveInputChannel("fire", false, true) === null, "fire was assigned a TCP fallback before UDP became ready");
assert(game.resolveInputChannel("fire", false, false) === null, "fire was enabled when UDP was disabled");
assert(game.resolveInputChannel("fire", true, true) === game.CHANNEL_UDP, "fire was not assigned to the UDP channel after negotiation");
assert(game.resolveInputChannel("move-forward", false, true) === game.CHANNEL_TCP, "movement lost its pre-UDP TCP fallback");
assert(game.acceptsServerOrder(null, 0), "the first authoritative player order was rejected");
assert(game.acceptsServerOrder(15, 16), "a newer authoritative player order was rejected");
assert(!game.acceptsServerOrder(15, 14), "a stale authoritative player order was accepted");
assert(!game.acceptsServerOrder(15, 15), "a duplicate authoritative player order was accepted");

let lifecycle = game.createSessionLifecycle(true);
assert(lifecycle.phase === "connecting" && lifecycle.udpState === "idle", "session lifecycle did not start in connecting/idle state");
lifecycle = game.applySessionLifecycle(lifecycle, "socket-open");
lifecycle = game.applySessionLifecycle(lifecycle, "handshake-ready");
lifecycle = game.applySessionLifecycle(lifecycle, "enter-sent");
assert(lifecycle.phase === "joining" && lifecycle.tcpReady, "session handshake lifecycle was not advanced");
lifecycle = game.applySessionLifecycle(lifecycle, "accepted");
lifecycle = game.applySessionLifecycle(lifecycle, "local-joined", { playerId: 7 });
lifecycle = game.applySessionLifecycle(lifecycle, "alive");
assert(lifecycle.phase === "playing" && lifecycle.joined && lifecycle.alive, "accepted player did not enter the playing state");
assert(game.canSendSessionInput(lifecycle, "move-forward", "start"), "live movement was blocked by the session gate");
lifecycle = game.applySessionLifecycle(lifecycle, "pause", { paused: true });
assert(lifecycle.phase === "paused" && !game.canSendSessionInput(lifecycle, "fire", "start"), "paused fire input was not blocked");
lifecycle = game.applySessionLifecycle(lifecycle, "pause", { paused: false });
lifecycle = game.applySessionLifecycle(lifecycle, "killed");
assert(lifecycle.phase === "dead" && lifecycle.respawnPending, "death did not arm respawn state");
assert(game.canSendSessionInput(lifecycle, "restart", "end"), "restart release was blocked while dead");
lifecycle = game.applySessionLifecycle(lifecycle, "local-left");
lifecycle = game.applySessionLifecycle(lifecycle, "socket-close", { reason: "test close" });
assert(lifecycle.closed && lifecycle.phase === "closed", "session close did not reach the terminal state");

const physics = game.createInputState();
Object.assign(physics, {
  playerId: 7,
  physicsReady: true,
  alive: true,
  clientTime: 10,
  timestamp: 10,
  position: [0, 0, 0],
  velocity: [100000, 0, 0],
  angularVelocity: 100
});
assert(game.advanceClientPhysics(physics, 11), "bounded client physics did not advance");
assert(physics.position[0] === 100 && physics.velocity[0] === 1000, "client physics exceeded the bounded step or speed");
const pausedPosition = physics.position[0];
physics.paused = true;
assert(!game.advanceClientPhysics(physics, 12) && physics.position[0] === pausedPosition, "paused client physics continued to integrate");
physics.paused = false;
physics.clientTime = 1_800_000_000;
physics.position = [0, 0, 0];
assert(game.advanceClientPhysics(physics, 1_800_000_000.2), "epoch-based client clock was incorrectly clamped");
const sanitized = game.sanitizePhysicsSnapshot({
  playerId: 999,
  position: [Number.NaN, Number.POSITIVE_INFINITY, 4],
  velocity: [999999, 0, 0],
  order: 9999999999
}, physics);
assert(sanitized.playerId === 7 && sanitized.position[2] === 4 && sanitized.velocity[0] === 1000, "unsafe physics values were not sanitized");

context.window.BZFlagWebProtocol = protocol;
const firingInput = game.createInputState();
Object.assign(firingInput, {
  playerId: 7,
  physicsReady: true,
  alive: true,
  timestamp: 22,
  position: [1, 2, 3],
  velocity: [4, 5, 6],
  azimuth: 0,
  team: 1
});
const firing = game.createFiringState(firingInput, { team: "red", shotSpeed: 500 });
assert(firing && firing.playerId === 7 && firing.shotId === 0, "bounded firing state was not created");
assert(firing.velocity[0] === 504 && firing.velocity[1] === 5, "firing velocity did not use the authoritative heading and speed");

Object.assign(protocol, {
  MSG_ADD_PLAYER: 0x6170,
  MSG_ALIVE: 0x616c,
  MSG_PLAYER_UPDATE: 0x7075,
  MSG_PLAYER_UPDATE_SMALL: 0x7073,
  MSG_KILLED: 0x6b6c,
  MSG_PAUSE: 0x7061,
  MSG_REMOVE_PLAYER: 0x726d
});
const session = {
  connection: { useUDP: true },
  inputState: game.createInputState(),
  lifecycle: game.createSessionLifecycle(true),
  socket: null,
  renderer: {},
  serverPlayerOrder: null
};
session.inputState.playerId = 7;
const authoritative = {
  valid: true,
  code: protocol.MSG_PLAYER_UPDATE,
  data: {
    playerId: 7,
    order: 1,
    status: 1,
    timestamp: 20,
    position: [1, 2, 3],
    velocity: [4, 5, 6],
    azimuth: 0,
    angularVelocity: 0
  },
  payload: new Uint8Array([7])
};
assert(game.applySessionProtocolResult(session, authoritative), "authoritative player state was rejected");
assert(session.lifecycle.phase === "playing" && session.lifecycle.alive, "authoritative alive state did not activate the session");
assert(!game.applySessionProtocolResult(session, { ...authoritative, data: { ...authoritative.data, order: 1 } }), "stale authoritative state was accepted");
assert(game.applySessionProtocolResult(session, {
  ...authoritative,
  code: protocol.MSG_KILLED,
  data: { victim: 7 },
  payload: new Uint8Array([7])
}), "local death event was rejected");
assert(session.lifecycle.phase === "dead" && !session.lifecycle.alive, "local death did not stop gameplay input");

context.window.BZFlagWebProtocol = protocol;
let udpReady = false;
const keyboardAudio = { play() {} };
const keyboardSocket = { readyState: FakeWebSocket.OPEN, send(frame) { frames.push(frame); } };
const stopKeyboard = game.bindKeyboard(
  keyboardSocket,
  keyboardAudio,
  () => ({ firing: { playerId: 7, shotId: 1, position: [0, 0, 0], velocity: [1, 0, 0] } }),
  (command) => game.resolveInputChannel(command, udpReady, true)
);
const fireDown = { code: "Enter", target: null, preventDefault() {} };
windowListeners.get("keydown")(fireDown);
assert(frames.length === 1, "fire emitted a frame before UDP readiness");
assert(new Uint8Array(frames.at(-1))[5] === 0, "pre-UDP fire changed an earlier non-fire frame");
windowListeners.get("keyup")({ code: "Enter", target: null });
udpReady = true;
windowListeners.get("keydown")(fireDown);
assert(frames.length === 2, "fire was not sent after UDP readiness");
assert(new Uint8Array(frames.at(-1))[5] === game.CHANNEL_UDP, "fire was not sent through the UDP bridge channel");
stopKeyboard();

let closeCode = null;
game.handleProtocolFollowUp({ socket: { readyState: FakeWebSocket.OPEN, close(code) { closeCode = code; } } }, { valid: true, code: protocol.MSG_SUPER_KILL });
assert(closeCode === 1008, "MsgSuperKill did not close the browser session");

console.log("Client game checks passed (bounded chat and UDP-only fire channel).");

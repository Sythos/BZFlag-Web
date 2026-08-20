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

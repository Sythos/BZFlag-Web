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

import { createWorldState } from "../dist/state.js";

const MSG_PLAYER_UPDATE = 0x7075;
const MSG_PLAYER_UPDATE_SMALL = 0x7073;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const state = createWorldState({ players: 4 });
const rejected = state.setWorldGeometry({ source: "wasm-decoder", objects: [{ kind: "not-a-world-object" }] });
assert(rejected.applied && rejected.objectCount === 0, "empty decoded geometry should remain a valid state boundary");
const geometry = state.setWorldGeometry({
  source: "native-adapter",
  mapVersion: 3,
  objects: [
    { kind: "box", position: [4, 5, 1], size: [2, 3, 4] },
    { kind: "teleporter", position: [8, 2, 0], size: [1, 1, 5], rotation: 1.25 }
  ]
});
assert(geometry.applied && geometry.objectCount === 2, "decoded geometry was not applied to WorldState");
const snapshot = state.snapshot();
assert(snapshot.worldGeometry?.objectCount === 2, "WorldState snapshot omitted decoded geometry");
assert(snapshot.worldGeometry?.objects[1].kind === "teleporter", "WorldState snapshot changed geometry kind");
snapshot.worldGeometry.objects[0].position[0] = 999;
assert(state.snapshot().worldGeometry?.objects[0].position[0] === 4, "WorldState geometry snapshot is not isolated");
assert(state.clearWorldGeometry().applied, "WorldState did not clear decoded geometry");
assert(state.snapshot().worldGeometry === null, "WorldState retained cleared geometry");

function playerUpdate(code, playerId, order, x) {
  return {
    code,
    data: {
      playerId,
      order,
      position: [x, 0, 0],
      velocity: [0, 0, 0],
      timestamp: order
    }
  };
}

const ordered = createWorldState({ players: 4 });
const first = ordered.apply(playerUpdate(MSG_PLAYER_UPDATE, 7, 0, 7));
assert(first.applied, "the first player update must be preserved even with order zero");
assert(ordered.snapshot().players[0].position[0] === 7, "the first player update was not stored");
const next = ordered.apply(playerUpdate(MSG_PLAYER_UPDATE_SMALL, 7, 15, 15));
assert(next.applied, "a strictly newer small player update was rejected");
const revisionAfterNew = ordered.snapshot().revision;
const stale = ordered.apply(playerUpdate(MSG_PLAYER_UPDATE, 7, 14, 14));
assert(!stale.applied && stale.reason === "stale-player-order", "an out-of-order player update was accepted");
assert(ordered.snapshot().revision === revisionAfterNew, "a stale player update changed the world revision");
assert(ordered.snapshot().players[0].order === 15 && ordered.snapshot().players[0].position[0] === 15, "a stale player update replaced newer state");
const newer = ordered.apply(playerUpdate(MSG_PLAYER_UPDATE, 7, 16, 16));
assert(newer.applied && ordered.snapshot().players[0].order === 16, "a strictly newer player update was rejected");
const duplicate = ordered.apply(playerUpdate(MSG_PLAYER_UPDATE, 7, 16, 20));
assert(!duplicate.applied, "an equal player order was accepted");
const independent = ordered.apply(playerUpdate(MSG_PLAYER_UPDATE, 8, 1, 8));
assert(independent.applied, "player order tracking was not scoped per entity");

assert(ordered.apply({ code: 0x7270, data: { playerId: 7 } }).applied, "player removal was rejected");
assert(ordered.apply({ code: 0x6170, data: { playerId: 7 } }).applied, "player rejoin was rejected");
assert(ordered.apply(playerUpdate(MSG_PLAYER_UPDATE, 7, 0, 70)).applied, "a re-added entity did not preserve its first update");

console.log("Client state checks passed (validated world geometry isolation and ordered player updates).");

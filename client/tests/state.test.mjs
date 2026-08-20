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

console.log("Client state checks passed (validated world geometry application and snapshot isolation).");

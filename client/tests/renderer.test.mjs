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

const rendererPath = fileURLToPath(new URL("../dist/renderer.js", import.meta.url));
const source = await readFile(rendererPath, "utf8");
const context = {
  ArrayBuffer,
  Float32Array,
  Number,
  Math,
  window: { devicePixelRatio: 1 },
  console
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "dist/renderer.js" });
const renderer = context.window.BZFlagWebRenderer;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const snapshot = {
  revision: 7,
  players: [{ playerId: 3, team: 3, alive: true, status: 1, position: [4, 5, 1], azimuth: 0.75 }],
  shots: [{ playerId: 3, shotId: 8, team: 3, flag: "SW", position: [6, 7, 0.4] }],
  flags: [{ flagIndex: 1, flagType: "R*", position: [2, 3, 0] }],
  messages: [],
  worldGeometry: {
    source: "wasm-decoder",
    mapVersion: 3,
    objects: [
      { id: "box-1", kind: "box", position: [10, 20, 3], size: [4, 6, 2], rotation: 0.25 },
      { id: "teleporter-1", kind: "teleporter", position: [0, 4, 0], size: [2, 2, 5], rotation: 1 }
    ]
  }
};

const first = renderer.sceneObjects(snapshot, 1000);
const second = renderer.sceneObjects(snapshot, 1000);
assert(JSON.stringify(first) === JSON.stringify(second), "renderer scene generation is not deterministic");
assert(first.some((object) => object.kind === "world-box"), "decoded box geometry was not rendered");
assert(first.some((object) => object.kind === "world-teleporter-ring"), "teleporter geometry did not produce its visible ring");
assert(first.some((object) => object.kind === "tank-body"), "authoritative player tank body was not rendered");
assert(first.some((object) => object.kind === "tank-turret"), "authoritative player turret was not rendered");
assert(first.filter((object) => object.kind === "tank-track").length === 2, "tank tracks were not rendered symmetrically");
assert(first.some((object) => object.kind === "shot") && first.some((object) => object.kind === "shot-glow"), "shot and shot glow were not rendered");
assert(first.some((object) => object.kind === "flag-pole") && first.some((object) => object.kind === "flag-cloth"), "flag pole and cloth were not rendered");
const box = first.find((object) => object.kind === "world-box");
assert(box.position[0] === 10 && box.position[1] === 3 && box.position[2] === 20, "world coordinates were not mapped to renderer coordinates");
assert(box.size[0] === 4 && box.size[1] === 2 && box.size[2] === 6, "world dimensions were not mapped to renderer dimensions");

console.log("Client renderer checks passed (deterministic geometry and entity scene objects).");

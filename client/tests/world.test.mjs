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
import { deflateSync } from "node:zlib";
const source = await readFile(new URL("../dist/world.js", import.meta.url), "utf8");
const moduleUrl = new URL("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
const world = await import(moduleUrl.href);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeEnvelope(compressed, { mapVersion = 1, uncompressedBytes = 17 } = {}) {
  const bytes = new Uint8Array(world.WORLD_HEADER_BYTES + compressed.length + world.WORLD_FOOTER_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, world.WORLD_HEADER_LENGTH);
  view.setUint16(2, world.WORLD_CODE_HEADER);
  view.setUint16(4, mapVersion);
  view.setUint32(6, uncompressedBytes);
  view.setUint32(10, compressed.length);
  bytes.set(compressed, world.WORLD_HEADER_BYTES);
  const footer = world.WORLD_HEADER_BYTES + compressed.length;
  view.setUint16(footer, world.WORLD_END_LENGTH);
  view.setUint16(footer + 2, world.WORLD_CODE_END);
  return bytes;
}

class NativeWriter {
  constructor() {
    this.bytes = [];
  }

  raw(value) {
    for (const byte of value) this.bytes.push(byte);
    return this;
  }

  u8(value) {
    this.bytes.push(Number(value) & 0xff);
    return this;
  }

  u16(value) {
    return this.raw([(value >>> 8) & 0xff, value & 0xff]);
  }

  u32(value) {
    return this.raw([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
  }

  i32(value) {
    return this.u32(value >>> 0);
  }

  f32(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value, false);
    return this.raw(bytes);
  }

  vec(values) {
    return this.f32(values[0]).f32(values[1]).f32(values[2]);
  }

  str(value) {
    const bytes = new TextEncoder().encode(value);
    return this.u32(bytes.length).raw(bytes);
  }

  flag(value) {
    return this.raw(new TextEncoder().encode(value).slice(0, 2));
  }

  finish() {
    return Uint8Array.from(this.bytes);
  }
}

function writeEmptyObstacleLists(writer) {
  for (let i = 0; i < 10; i += 1) writer.u32(0);
}

function writeBox(writer, position = [0, 0, 0], rotation = 0, size = [1, 1, 1], state = 0) {
  return writer.vec(position).f32(rotation).vec(size).u8(state);
}

function writeInlineTransform(writer, name = "", operations = []) {
  writer.str(name).u32(operations.length);
  for (const operation of operations) {
    writer.u8(operation.type);
    if (operation.type === 4) writer.i32(operation.index);
    else {
      writer.vec(operation.vector);
      if (operation.type === 3) writer.f32(operation.angle);
    }
  }
}

function makeNativeManagerStream() {
  const writer = new NativeWriter();

  // DynamicColorManager, TextureMatrixManager.
  writer.u32(0).u32(0);

  // One material exercises std::string, colors, texture and shader lists.
  writer.u32(1).str("water").u8(0).i32(-1);
  for (let i = 0; i < 4; i += 1) writer.f32(0.1).f32(0.2).f32(0.3).f32(0.4);
  writer.f32(8).f32(0.25).u8(1).str("water.png").i32(0).i32(1).u8(1).u8(1).str("water-shader");

  // One PhysicsDriver.
  writer.u32(1).str("slide").vec([1, 2, 3]).f32(0.5).f32(0.1).f32(0.2).f32(0.3).f32(0.4).f32(0.5).f32(2).str("fell");

  // One named transform with shift and spin operations.
  writer.u32(1).str("root").u32(2).u8(0).vec([1, 2, 3]).u8(3).vec([0, 0, 1]).f32(0.5);

  // ObstacleMgr world group: all ten native categories, in enum order.
  writer.u32(1).vec([1, 2, 3]).f32(0.25).f32(4).f32(5).u8(8); // wall
  writer.u32(1); writeBox(writer, [4, 5, 6], 0.5, [2, 3, 4], 9); // box
  writer.u32(1); writeBox(writer, [7, 8, 9], 0.75, [3, 4, 5], 5); // pyramid
  writer.u32(1).u16(2); writeBox(writer, [10, 11, 12], 1, [6, 7, 8], 8); // base
  writer.u32(1).str("tele-A").vec([13, 14, 15]).f32(1.25).vec([2, 2, 4]).f32(0.25).u8(1).u8(9); // teleporter

  // Minimal valid mesh: three vertices and one face, no hidden draw-info.
  writer.u32(1).i32(0).i32(3).vec([0, 0, 0]).vec([1, 0, 0]).vec([0, 1, 0]).i32(0).i32(0).i32(1).u8(0).i32(3).i32(0).i32(1).i32(2).i32(-1).i32(-1).u8(0);

  // Arc, cone, sphere and tetra exercise every unsupported native obstacle reader.
  writer.u32(1); writeInlineTransform(writer); writer.vec([1, 1, 1]).vec([2, 2, 2]).f32(0).f32(1).f32(0.5).i32(8).i32(-1);
  for (let i = 0; i < 4; i += 1) writer.f32(1); for (let i = 0; i < 6; i += 1) writer.i32(0); writer.u8(0); // arc
  writer.u32(1); writeInlineTransform(writer); writer.vec([2, 2, 2]).vec([3, 3, 3]).f32(0).f32(1).i32(8).i32(-1);
  writer.f32(1).f32(1); for (let i = 0; i < 4; i += 1) writer.i32(0); writer.u8(0); // cone
  writer.u32(1); writeInlineTransform(writer); writer.vec([3, 3, 3]).vec([4, 4, 4]).f32(0).i32(8).i32(-1);
  writer.f32(1).f32(1).i32(0).i32(0).u8(0); // sphere
  writer.u32(1).u8(0); writeInlineTransform(writer);
  for (let i = 0; i < 4; i += 1) writer.vec([i, i + 1, i + 2]);
  writer.u8(0).u8(0); for (let i = 0; i < 4; i += 1) writer.i32(0); // tetra

  // One group definition with one box and one instance.
  writer.u32(1).str("decor");
  writer.u32(0); writer.u32(1); writeBox(writer, [20, 20, 0], 0, [2, 2, 2], 0);
  for (let i = 2; i < 10; i += 1) writer.u32(0);
  writer.u32(1).str("decor").str("instance"); writeInlineTransform(writer); writer.u8(1 | 2 | 4 | 8).u16(3).vec([0.5, 0.6, 0.7]).f32(0.8).i32(0).i32(0);

  // Teleporter links, water, world weapons and entry zones.
  writer.u32(1).str("tele-A").str("tele-B");
  writer.f32(12.5).i32(0);
  writer.u32(1).flag("SW").vec([30, 31, 32]).f32(1.5).f32(0.25).u16(2).f32(0.5).f32(0.75);
  writer.u32(1).vec([40, 41, 42]).vec([5, 6, 7]).f32(0.5).u16(1).u16(1).u16(1).flag("SW").u16(2).u16(3);
  return writer.finish();
}

const managerStream = makeNativeManagerStream();
const compressedDatabase = deflateSync(managerStream);
const database = makeEnvelope(compressedDatabase, { mapVersion: 1, uncompressedBytes: managerStream.length });
const envelope = world.parseWorldEnvelope(database);
assert(envelope.valid, "valid BZFlag world envelope was rejected");
assert(envelope.mapVersion === 1 && envelope.compressedBytes === compressedDatabase.length, "world envelope metadata was not decoded");
assert(envelope.compressed[0] === compressedDatabase[0], "compressed world payload was not retained");
const summary = world.summarizeWorldEnvelope(envelope);
assert(summary.valid && summary.compression === "zlib", "world envelope summary is incomplete");
assert(summary.sections.includes("obstacles") && summary.objectDecoder === "native-bzflag-required", "world manager summary lost its safe decoder boundary");
assert(summary.geometryReady === false, "compressed world summary must not claim decoded geometry");

const geometry = world.normalizeWorldGeometry({
  source: "wasm-decoder",
  mapVersion: 1,
  objects: [
    { id: "box-1", kind: "box", position: [10, 20, 3], size: [4, 6, 2], rotation: 0.5, team: 2 },
    { kind: "basebuilding", position: [0, 0, 0], size: [8, 8, 3], color: [0.2, 0.4, 0.8, 1] },
    { kind: "unknown", position: [999, 999, 999] },
    { kind: "wall", position: [0, 0, 0], size: [Number.POSITIVE_INFINITY, 4, 4] }
  ]
});
assert(geometry?.objectCount === 3, "world geometry adapter did not retain only recognized bounded objects");
assert(geometry?.source === "wasm-decoder" && geometry.objects[1].kind === "base", "world geometry aliases were not normalized");
assert(geometry?.objects[2].size[0] === 1, "non-finite geometry dimensions were not bounded");

const assembler = world.createWorldTransferAssembler({ maxChunkBytes: 8, maxChunks: 512 });
let offset = 0;
let chunkIndex = 0;
const chunkSizes = [3, 4, 5, 6, 4];
while (offset < database.length) {
  const size = chunkSizes[chunkIndex % chunkSizes.length];
  const end = Math.min(database.length, offset + size);
  const chunk = database.slice(offset, end);
  const bytesLeft = database.length - end;
  const state = assembler.push({ bytesLeft, chunk });
  assert(state.bytesReceived === end, "world transfer assembler reported an incorrect offset");
  offset = end;
  chunkIndex += 1;
}
const complete = assembler.snapshot();
assert(complete.complete && complete.chunkCount === chunkIndex, "world transfer assembler did not complete safely");
assert(complete.summary?.mapVersion === 1, "completed world transfer did not expose the parsed summary");
assert(assembler.bytes().every((value, index) => value === database[index]), "world transfer assembler corrupted a chunk");

const decoded = world.decodeWorldDatabase(managerStream, { mapVersion: 1 });
assert(decoded.valid && decoded.geometryReady && decoded.decoder === "typescript-native", "native manager stream was not decoded");
assert(decoded.consumedBytes === managerStream.length && decoded.objectCount === 5, "decoded manager cursor or renderable object count is incorrect");
assert(decoded.managerOrder[4] === "transforms" && decoded.managerOrder[9] === "entry-zones", "native manager order was not retained");
assert(decoded.materials.length === 1 && decoded.materials[0].textures[0].name === "water.png", "material manager was not decoded");
assert(decoded.physicsDrivers[0].name === "slide" && decoded.transforms[0].operations.length === 2, "physics or transform manager was not decoded");
assert(decoded.obstacles.some((record) => record.kind === "teleporter" && record.name === "tele-A"), "teleporter obstacle was not decoded");
assert(decoded.links[0].source === "tele-A" && decoded.water.level === 12.5 && decoded.water.materialIndex === 0, "links or water data was not decoded");
assert(decoded.weapons[0].flagType === "SW" && decoded.weapons[0].delays.length === 2, "world weapon data was not decoded");
assert(decoded.entryZones[0].flags[0] === "SW" && decoded.entryZones[0].teams[0] === 2, "entry-zone data was not decoded");
assert(decoded.groupDefinitions[0].name === "decor" && decoded.groupDefinitions[0].instances.length === 1, "group definition data was not preserved");
assert(decoded.unsupported.some((record) => record.kind === "mesh") && decoded.unsupported.some((record) => record.kind === "tetra"), "unsupported native obstacles were not preserved explicitly");
if (typeof DecompressionStream === "function") {
  const decodedEnvelope = await world.decodeWorldEnvelope(envelope);
  assert(decodedEnvelope.objectCount === decoded.objectCount && decodedEnvelope.consumedBytes === managerStream.length, "compressed native envelope did not decode to the same snapshot");
}

const wrongVersion = makeEnvelope(compressedDatabase, { mapVersion: 3, uncompressedBytes: managerStream.length });
assert(!world.parseWorldEnvelope(wrongVersion).valid, "unsupported map version was accepted");

let truncated = false;
try {
  world.decodeWorldDatabase(managerStream.slice(0, -1));
} catch (error) {
  truncated = error?.name === "WorldDecodeError";
}
assert(truncated, "truncated native manager stream was accepted");

let trailing = false;
try {
  world.decodeWorldDatabase(Uint8Array.from([...managerStream, 0]));
} catch (error) {
  trailing = error?.name === "WorldDecodeError";
}
assert(trailing, "native manager stream with trailing bytes was accepted");

let corruptCount = false;
try {
  const corrupted = managerStream.slice();
  new DataView(corrupted.buffer).setUint32(0, 0xffffffff, false);
  world.decodeWorldDatabase(corrupted);
} catch (error) {
  corruptCount = error?.name === "WorldDecodeError";
}
assert(corruptCount, "corrupted manager count was accepted");

let inconsistent = false;
try {
  const invalid = world.createWorldTransferAssembler({ maxChunkBytes: 8 });
  invalid.push({ bytesLeft: 4, chunk: Uint8Array.from([1, 2]) });
  invalid.push({ bytesLeft: 1, chunk: Uint8Array.from([3]) });
} catch {
  inconsistent = true;
}
assert(inconsistent, "inconsistent world chunk offsets were accepted");

let oversized = false;
try {
  const limited = world.createWorldTransferAssembler({ maxTransferBytes: database.length - 1 });
  limited.push({ bytesLeft: database.length - 1, chunk: database.slice(0, 1) });
  limited.push({ bytesLeft: 0, chunk: database.slice(1) });
} catch {
  oversized = true;
}
assert(oversized, "world transfer byte limit was not enforced");

const malformed = database.slice();
new DataView(malformed.buffer).setUint16(2, 0xffff);
assert(!world.parseWorldEnvelope(malformed).valid, "malformed world header was accepted");

console.log("Client world pipeline checks passed (bounded chunks, native envelope, safe summary).");

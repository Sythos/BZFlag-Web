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

const database = makeEnvelope(Uint8Array.from([0x78, 0x9c, 0x03, 0x00]), { mapVersion: 3, uncompressedBytes: 17 });
const envelope = world.parseWorldEnvelope(database);
assert(envelope.valid, "valid BZFlag world envelope was rejected");
assert(envelope.mapVersion === 3 && envelope.compressedBytes === 4, "world envelope metadata was not decoded");
assert(envelope.compressed[0] === 0x78, "compressed world payload was not retained");
const summary = world.summarizeWorldEnvelope(envelope);
assert(summary.valid && summary.compression === "zlib", "world envelope summary is incomplete");
assert(summary.sections.includes("obstacles") && summary.objectDecoder === "native-bzflag-required", "world manager summary lost its safe decoder boundary");

const assembler = world.createWorldTransferAssembler({ maxChunkBytes: 8, maxChunks: 8 });
let offset = 0;
for (const size of [3, 4, 5, 6, 4]) {
  const end = Math.min(database.length, offset + size);
  const chunk = database.slice(offset, end);
  const bytesLeft = database.length - end;
  const state = assembler.push({ bytesLeft, chunk });
  assert(state.bytesReceived === end, "world transfer assembler reported an incorrect offset");
  offset = end;
}
const complete = assembler.snapshot();
assert(complete.complete && complete.chunkCount === 5, "world transfer assembler did not complete safely");
assert(complete.summary?.mapVersion === 3, "completed world transfer did not expose the parsed summary");
assert(assembler.bytes().every((value, index) => value === database[index]), "world transfer assembler corrupted a chunk");

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

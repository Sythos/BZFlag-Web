// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Sythos (https://www.sythos.net)
//
// MIT License
//
// Copyright (c) 2026 Sythos (https://www.sythos.net)
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * Bounded handling for the BZFlag world database transfer.
 *
 * BZFS sends a world database through repeated MsgGetWorld packets.  The
 * packet payload contains a big-endian uint32 with the number of bytes still
 * to follow, followed by the next chunk.  The completed database contains a
 * small native BZFlag envelope and a zlib-compressed manager stream.  This
 * module deliberately stops at that boundary: decoding every manager stream
 * requires the native BZFlag object model and is not silently approximated in
 * the browser.  The envelope and transfer summary are nevertheless useful to
 * the renderer, telemetry, and compatibility checks.
 */

export const WORLD_CODE_NAMES = Object.freeze({
  0x6865: "header",
  0x6261: "base",
  0x6278: "box",
  0x6564: "end",
  0x6c6e: "link",
  0x7079: "pyramid",
  0x6d65: "mesh",
  0x6172: "arc",
  0x636e: "cone",
  0x7370: "sphere",
  0x7468: "tetra",
  0x7465: "teleporter",
  0x776c: "wall",
  0x7765: "weapon",
  0x7a6e: "zone",
  0x6772: "group",
  0x6473: "group-definition-start",
  0x6465: "group-definition-end"
});

export const WORLD_CODE_HEADER = 0x6865;
export const WORLD_CODE_END = 0x6564;
export const WORLD_HEADER_BYTES = 14;
export const WORLD_FOOTER_BYTES = 4;
export const WORLD_HEADER_LENGTH = 10;
export const WORLD_END_LENGTH = 0;
export const DEFAULT_WORLD_LIMITS = Object.freeze({
  maxTransferBytes: 64 * 1024 * 1024,
  maxUncompressedBytes: 128 * 1024 * 1024,
  maxChunkBytes: 64 * 1024,
  maxChunks: 4096
});

function finiteInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("Expected an ArrayBuffer or Uint8Array");
}

function invalidEnvelope(error: string): WorldEnvelope {
  return Object.freeze({ valid: false, error });
}

export interface WorldEnvelope {
  readonly valid: boolean;
  readonly error?: string;
  readonly mapVersion?: number;
  readonly uncompressedBytes?: number;
  readonly compressedBytes?: number;
  readonly totalBytes?: number;
  readonly compressed?: Uint8Array;
  readonly headerCode?: number;
  readonly endCode?: number;
}

export interface WorldEnvelopeSummary {
  readonly valid: boolean;
  readonly format: "bzflag-world-database";
  readonly mapVersion?: number;
  readonly compressedBytes?: number;
  readonly uncompressedBytes?: number;
  readonly totalBytes?: number;
  readonly compression: "zlib";
  readonly sections: readonly string[];
  readonly objectDecoder: "native-bzflag-required";
  readonly error?: string;
}

export interface WorldChunk {
  readonly bytesLeft: number;
  readonly chunk: Uint8Array;
}

function clampLimits(options: Record<string, unknown> = {}) {
  return {
    maxTransferBytes: finiteInteger(options.maxTransferBytes, 1, DEFAULT_WORLD_LIMITS.maxTransferBytes, DEFAULT_WORLD_LIMITS.maxTransferBytes),
    maxUncompressedBytes: finiteInteger(options.maxUncompressedBytes, 1, DEFAULT_WORLD_LIMITS.maxUncompressedBytes, DEFAULT_WORLD_LIMITS.maxUncompressedBytes),
    maxChunkBytes: finiteInteger(options.maxChunkBytes, 1, DEFAULT_WORLD_LIMITS.maxChunkBytes, DEFAULT_WORLD_LIMITS.maxChunkBytes),
    maxChunks: finiteInteger(options.maxChunks, 1, DEFAULT_WORLD_LIMITS.maxChunks, DEFAULT_WORLD_LIMITS.maxChunks)
  };
}

/**
 * Validate and describe the native BZFlag world database envelope.
 *
 * The function never attempts to allocate based on an untrusted size field.
 * It first checks the configured limits and the complete envelope length, then
 * returns a copy of the compressed payload for an optional decompressor.
 */
export function parseWorldEnvelope(input: unknown, options: Record<string, unknown> = {}): WorldEnvelope {
  let bytes: Uint8Array;
  try {
    bytes = toUint8Array(input);
  } catch (error) {
    return invalidEnvelope(error instanceof Error ? error.message : "Invalid world database bytes");
  }
  const limits = clampLimits(options);
  if (bytes.byteLength < WORLD_HEADER_BYTES + WORLD_FOOTER_BYTES) {
    return invalidEnvelope("BZFlag world database envelope is truncated");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint16(0);
  const headerCode = view.getUint16(2);
  if (headerLength !== WORLD_HEADER_LENGTH || headerCode !== WORLD_CODE_HEADER) {
    return invalidEnvelope("BZFlag world database header is not recognized");
  }
  const mapVersion = view.getUint16(4);
  const uncompressedBytes = view.getUint32(6);
  const compressedBytes = view.getUint32(10);
  if (uncompressedBytes > limits.maxUncompressedBytes) {
    return invalidEnvelope("BZFlag world database exceeds the uncompressed size limit");
  }
  if (compressedBytes > limits.maxTransferBytes) {
    return invalidEnvelope("BZFlag world database exceeds the compressed size limit");
  }
  const expectedBytes = WORLD_HEADER_BYTES + compressedBytes + WORLD_FOOTER_BYTES;
  if (expectedBytes > limits.maxTransferBytes || expectedBytes !== bytes.byteLength) {
    return invalidEnvelope("BZFlag world database envelope length is inconsistent");
  }
  const footerOffset = WORLD_HEADER_BYTES + compressedBytes;
  const footerLength = view.getUint16(footerOffset);
  const endCode = view.getUint16(footerOffset + 2);
  if (footerLength !== WORLD_END_LENGTH || endCode !== WORLD_CODE_END) {
    return invalidEnvelope("BZFlag world database footer is not recognized");
  }
  return Object.freeze({
    valid: true,
    mapVersion,
    uncompressedBytes,
    compressedBytes,
    totalBytes: bytes.byteLength,
    compressed: bytes.slice(WORLD_HEADER_BYTES, footerOffset),
    headerCode,
    endCode
  });
}

/**
 * Return a renderer-safe summary without pretending that the native manager
 * stream is a sequence of independently parseable objects.  BZFlag packs
 * dynamic colours, materials, transforms, obstacles, links, weapons, and
 * entry zones into one zlib stream; the native client must decode those
 * managers in order.  The browser can use this summary until that decoder is
 * implemented or a WASM-compatible decoder is supplied.
 */
export function summarizeWorldEnvelope(envelope: WorldEnvelope): WorldEnvelopeSummary {
  if (!envelope?.valid) {
    return Object.freeze({
      valid: false,
      format: "bzflag-world-database",
      compression: "zlib",
      sections: [],
      objectDecoder: "native-bzflag-required",
      error: envelope?.error || "Invalid BZFlag world envelope"
    });
  }
  return Object.freeze({
    valid: true,
    format: "bzflag-world-database",
    mapVersion: envelope.mapVersion,
    compressedBytes: envelope.compressedBytes,
    uncompressedBytes: envelope.uncompressedBytes,
    totalBytes: envelope.totalBytes,
    compression: "zlib",
    sections: Object.freeze([
      "dynamic-colors",
      "texture-matrices",
      "materials",
      "physics-drivers",
      "obstacle-transforms",
      "obstacles",
      "teleporter-links",
      "water-level",
      "weapons",
      "entry-zones"
    ]),
    objectDecoder: "native-bzflag-required"
  });
}

/**
 * Decompress a validated world envelope when the host exposes the standard
 * browser DecompressionStream API.  No third-party decompressor is bundled;
 * callers can retain the safe envelope summary on older browsers.
 */
export async function decompressWorldEnvelope(envelope: WorldEnvelope, options: Record<string, unknown> = {}): Promise<Uint8Array> {
  if (!envelope?.valid || !envelope.compressed) throw new Error("A valid BZFlag world envelope is required");
  const limits = clampLimits(options);
  if ((envelope.uncompressedBytes || 0) > limits.maxUncompressedBytes) {
    throw new RangeError("BZFlag world database exceeds the uncompressed size limit");
  }
  const DecompressionStreamConstructor = (globalThis as typeof globalThis & {
    DecompressionStream?: new (format: string) => TransformStream;
  }).DecompressionStream;
  if (!DecompressionStreamConstructor) {
    throw new Error("This browser does not provide DecompressionStream");
  }
  const compressedCopy = envelope.compressed.slice().buffer as ArrayBuffer;
  const source = new Response(compressedCopy).body;
  if (!source) throw new Error("The browser could not create a decompression stream");
  const response = new Response(source.pipeThrough(new DecompressionStreamConstructor("deflate")));
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== envelope.uncompressedBytes) {
    throw new Error("BZFlag world database decompressed length is inconsistent");
  }
  return bytes;
}

export interface WorldTransferSnapshot {
  readonly complete: boolean;
  readonly failed: boolean;
  readonly bytesReceived: number;
  readonly totalBytes: number | null;
  readonly bytesLeft: number | null;
  readonly chunkCount: number;
  readonly envelope: WorldEnvelope | null;
  readonly summary: WorldEnvelopeSummary | null;
  readonly error?: string;
}

/**
 * Assemble MsgGetWorld chunks while enforcing the server-declared remaining
 * byte count and strict memory/chunk limits.
 */
export class WorldTransferAssembler {
  readonly limits: ReturnType<typeof clampLimits>;
  private chunks: Uint8Array[] = [];
  private bytesReceived = 0;
  private totalBytes: number | null = null;
  private bytesLeft: number | null = null;
  private complete = false;
  private failed = false;
  private error: string | undefined;
  private envelope: WorldEnvelope | null = null;
  private summary: WorldEnvelopeSummary | null = null;

  constructor(options: Record<string, unknown> = {}) {
    this.limits = clampLimits(options);
  }

  push(chunkData: WorldChunk): WorldTransferSnapshot {
    if (this.failed) throw new Error(this.error || "BZFlag world transfer is invalid");
    if (this.complete) throw new Error("BZFlag world transfer is already complete");
    if (!chunkData || !Number.isInteger(chunkData.bytesLeft) || chunkData.bytesLeft < 0 || chunkData.bytesLeft > this.limits.maxTransferBytes) {
      return this.fail("BZFlag world chunk has an invalid remaining byte count");
    }
    let chunk: Uint8Array;
    try {
      chunk = toUint8Array(chunkData.chunk);
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Invalid BZFlag world chunk");
    }
    if (chunk.byteLength > this.limits.maxChunkBytes) {
      return this.fail("BZFlag world chunk exceeds the chunk size limit");
    }
    if (this.chunks.length >= this.limits.maxChunks) return this.fail("BZFlag world transfer exceeds the chunk count limit");
    const nextBytes = this.bytesReceived + chunk.byteLength;
    if (nextBytes > this.limits.maxTransferBytes) return this.fail("BZFlag world transfer exceeds the byte limit");
    if (this.totalBytes === null) {
      this.totalBytes = chunkData.bytesLeft + chunk.byteLength;
      if (this.totalBytes > this.limits.maxTransferBytes) return this.fail("BZFlag world transfer exceeds the byte limit");
    }
    if (chunkData.bytesLeft !== this.totalBytes - nextBytes) {
      return this.fail("BZFlag world chunk remaining length is inconsistent");
    }
    if (chunk.byteLength === 0 && chunkData.bytesLeft > 0) {
      return this.fail("BZFlag world transfer made no progress");
    }
    this.chunks.push(chunk.slice());
    this.bytesReceived = nextBytes;
    this.bytesLeft = chunkData.bytesLeft;
    if (this.bytesLeft === 0) {
      this.complete = true;
      const envelope = parseWorldEnvelope(this.bytes(), this.limits);
      if (!envelope.valid) return this.fail(envelope.error || "BZFlag world envelope is invalid");
      this.envelope = envelope;
      this.summary = summarizeWorldEnvelope(envelope);
    }
    return this.snapshot();
  }

  bytes(): Uint8Array {
    const output = new Uint8Array(this.bytesReceived);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  snapshot(): WorldTransferSnapshot {
    return Object.freeze({
      complete: this.complete,
      failed: this.failed,
      bytesReceived: this.bytesReceived,
      totalBytes: this.totalBytes,
      bytesLeft: this.bytesLeft,
      chunkCount: this.chunks.length,
      envelope: this.envelope,
      summary: this.summary,
      ...(this.error ? { error: this.error } : {})
    });
  }

  reset(): void {
    this.chunks = [];
    this.bytesReceived = 0;
    this.totalBytes = null;
    this.bytesLeft = null;
    this.complete = false;
    this.failed = false;
    this.error = undefined;
    this.envelope = null;
    this.summary = null;
  }

  private fail(message: string): WorldTransferSnapshot {
    this.failed = true;
    this.complete = false;
    this.error = message;
    throw new Error(message);
  }
}

export function createWorldTransferAssembler(options: Record<string, unknown> = {}): WorldTransferAssembler {
  return new WorldTransferAssembler(options);
}

const api = {
  WORLD_CODE_NAMES,
  WORLD_CODE_HEADER,
  WORLD_CODE_END,
  WORLD_HEADER_BYTES,
  WORLD_FOOTER_BYTES,
  WORLD_HEADER_LENGTH,
  WORLD_END_LENGTH,
  DEFAULT_WORLD_LIMITS,
  parseWorldEnvelope,
  summarizeWorldEnvelope,
  decompressWorldEnvelope,
  WorldTransferAssembler,
  createWorldTransferAssembler
};

if (typeof globalThis !== "undefined") {
  (globalThis as typeof globalThis & { BZFlagWebWorld?: typeof api }).BZFlagWebWorld = api;
}

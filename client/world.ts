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
export const WORLD_MAP_VERSION = 1;
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

/**
 * Limits for the decompressed native manager stream.  These limits are
 * intentionally independent from the transfer limits: a valid BZFS map may
 * be large, but no untrusted count is allowed to turn into an unbounded JS
 * allocation.
 */
export const DEFAULT_WORLD_DATABASE_LIMITS = Object.freeze({
  maxStringBytes: 64 * 1024,
  maxManagerEntries: 4096,
  maxObstacleEntries: 4096,
  maxObstacleTotal: 16384,
  maxTransforms: 4096,
  maxMeshChecks: 4096,
  maxMeshVertices: 65536,
  maxMeshNormals: 65536,
  maxMeshTexcoords: 65536,
  maxMeshFaces: 65536,
  maxFaceVertices: 64,
  maxWeapons: 4096,
  maxWeaponDelays: 1024,
  maxEntryZones: 4096,
  maxZoneEntries: 4096,
  maxGroupDefinitions: 1024,
  maxGroupInstances: 4096,
  maxMaterialTextures: 255,
  maxMaterialShaders: 255,
  maxDynamicSequences: 4096,
  maxMaterialMappings: 4096
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

export class WorldDecodeError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "WorldDecodeError";
    this.offset = offset;
  }
}

export type WorldDatabaseLimits = { readonly [Key in keyof typeof DEFAULT_WORLD_DATABASE_LIMITS]: number };

function clampDatabaseLimits(options: Record<string, unknown> = {}): WorldDatabaseLimits {
  const value = (key: keyof typeof DEFAULT_WORLD_DATABASE_LIMITS): number => finiteInteger(
    options[key],
    1,
    DEFAULT_WORLD_DATABASE_LIMITS[key],
    DEFAULT_WORLD_DATABASE_LIMITS[key]
  );
  return Object.freeze({
    maxStringBytes: value("maxStringBytes"),
    maxManagerEntries: value("maxManagerEntries"),
    maxObstacleEntries: value("maxObstacleEntries"),
    maxObstacleTotal: value("maxObstacleTotal"),
    maxTransforms: value("maxTransforms"),
    maxMeshChecks: value("maxMeshChecks"),
    maxMeshVertices: value("maxMeshVertices"),
    maxMeshNormals: value("maxMeshNormals"),
    maxMeshTexcoords: value("maxMeshTexcoords"),
    maxMeshFaces: value("maxMeshFaces"),
    maxFaceVertices: value("maxFaceVertices"),
    maxWeapons: value("maxWeapons"),
    maxWeaponDelays: value("maxWeaponDelays"),
    maxEntryZones: value("maxEntryZones"),
    maxZoneEntries: value("maxZoneEntries"),
    maxGroupDefinitions: value("maxGroupDefinitions"),
    maxGroupInstances: value("maxGroupInstances"),
    maxMaterialTextures: value("maxMaterialTextures"),
    maxMaterialShaders: value("maxMaterialShaders"),
    maxDynamicSequences: value("maxDynamicSequences"),
    maxMaterialMappings: value("maxMaterialMappings")
  });
}

/**
 * Bounded network-byte-order reader used for the decompressed BZFS manager
 * stream.  It never advances past the input and rejects non-finite floats;
 * native Pack.cxx replaces NaN with an error, while a browser decoder must
 * also avoid carrying Infinity into renderer state.
 */
export class WorldByteReader {
  readonly bytes: Uint8Array;
  readonly limits: WorldDatabaseLimits;
  private offsetValue = 0;

  constructor(input: Uint8Array | ArrayBuffer | ArrayBufferView, limits: WorldDatabaseLimits = clampDatabaseLimits()) {
    this.bytes = toUint8Array(input);
    this.limits = limits;
  }

  get offset(): number {
    return this.offsetValue;
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offsetValue;
  }

  private require(length: number, label: string): void {
    if (!Number.isInteger(length) || length < 0 || length > this.remaining) {
      throw new WorldDecodeError(`truncated ${label}`, this.offsetValue);
    }
  }

  private view(length: number, label: string): DataView {
    this.require(length, label);
    return new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offsetValue, length);
  }

  readU8(label = "u8"): number {
    const view = this.view(1, label);
    const value = view.getUint8(0);
    this.offsetValue += 1;
    return value;
  }

  readU16(label = "u16"): number {
    const view = this.view(2, label);
    const value = view.getUint16(0, false);
    this.offsetValue += 2;
    return value;
  }

  readI32(label = "i32"): number {
    const view = this.view(4, label);
    const value = view.getInt32(0, false);
    this.offsetValue += 4;
    return value;
  }

  readU32(label = "u32"): number {
    const view = this.view(4, label);
    const value = view.getUint32(0, false);
    this.offsetValue += 4;
    return value;
  }

  readFloat32(label = "float32"): number {
    const view = this.view(4, label);
    const value = view.getFloat32(0, false);
    this.offsetValue += 4;
    if (!Number.isFinite(value)) throw new WorldDecodeError(`non-finite ${label}`, this.offsetValue - 4);
    return value;
  }

  readVector2(label = "vector2"): [number, number] {
    return [this.readFloat32(`${label}.x`), this.readFloat32(`${label}.y`)] as [number, number];
  }

  readVector3(label = "vector3"): GeometryVector3 {
    return [
      this.readFloat32(`${label}.x`),
      this.readFloat32(`${label}.y`),
      this.readFloat32(`${label}.z`)
    ];
  }

  readBytes(length: number, label = "bytes"): Uint8Array {
    this.require(length, label);
    const result = this.bytes.slice(this.offsetValue, this.offsetValue + length);
    this.offsetValue += length;
    return result;
  }

  readCount(label: string, maximum = this.limits.maxManagerEntries): number {
    const count = this.readU32(`${label}.count`);
    if (count > maximum) throw new WorldDecodeError(`${label} count exceeds limit`, this.offsetValue - 4);
    return count;
  }

  readSignedCount(label: string, maximum: number): number {
    const count = this.readI32(`${label}.count`);
    if (count < 0 || count > maximum) throw new WorldDecodeError(`${label} count is invalid`, this.offsetValue - 4);
    return count;
  }

  readStringBytes(label = "string"): Uint8Array {
    const length = this.readU32(`${label}.length`);
    if (length > this.limits.maxStringBytes) {
      throw new WorldDecodeError(`${label} exceeds string limit`, this.offsetValue - 4);
    }
    return this.readBytes(length, label);
  }

  readString(label = "string"): string {
    return new TextDecoder("utf-8", { fatal: false }).decode(this.readStringBytes(label));
  }

  readRawString(label = "string"): { readonly bytes: Uint8Array; readonly text: string } {
    const bytes = this.readStringBytes(label);
    return Object.freeze({
      bytes,
      text: new TextDecoder("utf-8", { fatal: false }).decode(bytes)
    });
  }
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
  readonly geometryReady: boolean;
  readonly error?: string;
}

export interface WorldChunk {
  readonly bytesLeft: number;
  readonly chunk: Uint8Array;
}

export const WORLD_GEOMETRY_KINDS = Object.freeze([
  "box",
  "wall",
  "pyramid",
  "base",
  "teleporter",
  "sphere",
  "cone",
  "arc",
  "mesh",
  "zone"
] as const);

export const WORLD_GEOMETRY_LIMITS = Object.freeze({
  maxObjects: 4096,
  maxCoordinate: 1_000_000,
  maxDimension: 1_000_000,
  maxLabelBytes: 64
});

export type WorldGeometryKind = (typeof WORLD_GEOMETRY_KINDS)[number];
export type GeometryVector3 = [number, number, number];
export type GeometryColor = [number, number, number, number];

export interface WorldGeometryObject {
  readonly id?: string;
  readonly kind: WorldGeometryKind;
  readonly position: GeometryVector3;
  readonly size: GeometryVector3;
  readonly rotation: number;
  readonly team?: number;
  readonly color?: GeometryColor;
  readonly material?: string;
}

export interface WorldGeometrySnapshot {
  readonly version: 1;
  readonly source: "native-adapter" | "wasm-decoder" | "world-database" | "unknown";
  readonly mapVersion: number | null;
  readonly objects: readonly WorldGeometryObject[];
  readonly objectCount: number;
}

export interface WorldTransformOperation {
  readonly type: "shift" | "scale" | "shear" | "spin" | "index";
  readonly vector?: GeometryVector3;
  readonly angle?: number;
  readonly index?: number;
}

export interface WorldTransformRecord {
  readonly name: string;
  readonly operations: readonly WorldTransformOperation[];
}

export interface WorldDynamicColorWave {
  readonly period: number;
  readonly offset: number;
  readonly weight: number;
}

export interface WorldDynamicColorChannel {
  readonly minimum: number;
  readonly maximum: number;
  readonly sinusoids: readonly WorldDynamicColorWave[];
  readonly clampUps: readonly WorldDynamicColorWave[];
  readonly clampDowns: readonly WorldDynamicColorWave[];
  readonly sequence: {
    readonly count: number;
    readonly period?: number;
    readonly offset?: number;
    readonly list: readonly number[];
  };
}

export interface WorldDynamicColorRecord {
  readonly name: string;
  readonly channels: readonly WorldDynamicColorChannel[];
}

export interface WorldTextureMatrixRecord {
  readonly name: string;
  readonly state: number;
  readonly staticValues?: readonly number[];
  readonly dynamicValues?: readonly number[];
}

export interface WorldMaterialTexture {
  readonly name: string;
  readonly matrix: number;
  readonly combineMode: number;
  readonly state: number;
}

export interface WorldMaterialRecord {
  readonly name: string;
  readonly mode: number;
  readonly dynamicColor: number;
  readonly ambient: GeometryColor;
  readonly diffuse: GeometryColor;
  readonly specular: GeometryColor;
  readonly emission: GeometryColor;
  readonly shininess: number;
  readonly alphaThreshold: number;
  readonly textures: readonly WorldMaterialTexture[];
  readonly shaders: readonly string[];
}

export interface WorldPhysicsDriverRecord {
  readonly name: string;
  readonly linear: GeometryVector3;
  readonly angularVelocity: number;
  readonly angularPosition: readonly [number, number];
  readonly radialVelocity: number;
  readonly radialPosition: readonly [number, number];
  readonly slideTime: number;
  readonly deathMessage: string;
}

export interface WorldLinkRecord {
  readonly source: string;
  readonly destination: string;
}

export interface WorldWeaponRecord {
  readonly flagType: string;
  readonly origin: GeometryVector3;
  readonly direction: number;
  readonly initialDelay: number;
  readonly delays: readonly number[];
}

export interface WorldEntryZoneRecord {
  readonly position: GeometryVector3;
  readonly size: GeometryVector3;
  readonly rotation: number;
  readonly flags: readonly string[];
  readonly teams: readonly number[];
  readonly safetyTeams: readonly number[];
}

export interface WorldObstacleRecord {
  readonly kind: string;
  readonly index: number;
  readonly supported: boolean;
  readonly [field: string]: unknown;
}

export interface WorldUnsupportedRecord {
  readonly manager: string;
  readonly kind: string;
  readonly index: number;
  readonly reason: string;
  readonly record: unknown;
}

export interface WorldGroupInstanceRecord {
  readonly groupDefinition: string;
  readonly name: string;
  readonly materialMappings: readonly { readonly source: number; readonly destination: number }[];
  readonly transform: WorldTransformRecord;
  readonly flags: number;
  readonly team?: number;
  readonly tint?: readonly [number, number, number, number];
  readonly physicsDriver?: number;
  readonly material?: number;
}

export interface WorldGroupDefinitionRecord {
  readonly name: string;
  readonly obstacles: Readonly<Record<string, readonly WorldObstacleRecord[]>>;
  readonly instances: readonly WorldGroupInstanceRecord[];
}

export interface WorldDatabaseSnapshot {
  readonly valid: true;
  readonly version: 1;
  readonly source: "world-database";
  readonly mapVersion: number;
  readonly decoder: "typescript-native";
  readonly geometryReady: true;
  readonly objects: readonly WorldGeometryObject[];
  readonly objectCount: number;
  readonly consumedBytes: number;
  readonly uncompressedBytes: number;
  readonly managerOrder: readonly string[];
  readonly dynamicColors: readonly WorldDynamicColorRecord[];
  readonly textureMatrices: readonly WorldTextureMatrixRecord[];
  readonly materials: readonly WorldMaterialRecord[];
  readonly physicsDrivers: readonly WorldPhysicsDriverRecord[];
  readonly transforms: readonly WorldTransformRecord[];
  readonly obstacles: readonly WorldObstacleRecord[];
  readonly links: readonly WorldLinkRecord[];
  readonly water: { readonly level: number; readonly materialIndex: number | null };
  readonly weapons: readonly WorldWeaponRecord[];
  readonly entryZones: readonly WorldEntryZoneRecord[];
  readonly groupDefinitions: readonly WorldGroupDefinitionRecord[];
  readonly unsupported: readonly WorldUnsupportedRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function boundedFloat(value: unknown, minimum: number, maximum: number, fallback = 0): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function geometryVector(value: unknown, fallback: GeometryVector3, minimum: number, maximum: number): GeometryVector3 {
  const source = Array.isArray(value) || ArrayBuffer.isView(value) ? value as ArrayLike<unknown> : fallback;
  return [
    boundedFloat(source[0], minimum, maximum, fallback[0]),
    boundedFloat(source[1], minimum, maximum, fallback[1]),
    boundedFloat(source[2], minimum, maximum, fallback[2])
  ];
}

function geometryKind(value: unknown): WorldGeometryKind | null {
  const normalized = String(value || "").trim().toLowerCase();
  const aliases: Record<string, WorldGeometryKind> = {
    boxbuilding: "box",
    basebuilding: "base",
    pyramidbuilding: "pyramid",
    teleporterbuilding: "teleporter"
  };
  const candidate = aliases[normalized] || normalized;
  return (WORLD_GEOMETRY_KINDS as readonly string[]).includes(candidate) ? candidate as WorldGeometryKind : null;
}

function geometryColor(value: unknown): GeometryColor | undefined {
  if (!(Array.isArray(value) || ArrayBuffer.isView(value))) return undefined;
  const source = value as ArrayLike<unknown>;
  return [
    boundedFloat(source[0], 0, 1, 0.45),
    boundedFloat(source[1], 0, 1, 0.48),
    boundedFloat(source[2], 0, 1, 0.52),
    boundedFloat(source[3], 0, 1, 1)
  ];
}

function geometryObject(raw: unknown): WorldGeometryObject | null {
  if (!isRecord(raw)) return null;
  const kind = geometryKind(raw.kind || raw.type || raw.objectType);
  if (!kind) return null;
  const positionValue = raw.position ?? [raw.x, raw.y, raw.z];
  const sizeValue = raw.size ?? raw.scale ?? [raw.width, raw.depth, raw.height];
  const position = geometryVector(positionValue, [0, 0, 0], -WORLD_GEOMETRY_LIMITS.maxCoordinate, WORLD_GEOMETRY_LIMITS.maxCoordinate);
  const size = geometryVector(sizeValue, [1, 1, 1], 0.01, WORLD_GEOMETRY_LIMITS.maxDimension);
  const result: WorldGeometryObject = {
    kind,
    position,
    size,
    rotation: boundedFloat(raw.rotation ?? raw.azimuth, -Math.PI * 1000, Math.PI * 1000, 0),
    ...(raw.id !== undefined ? { id: String(raw.id).slice(0, WORLD_GEOMETRY_LIMITS.maxLabelBytes) } : {}),
    ...(raw.team !== undefined ? { team: boundedFloat(raw.team, -1, 7, -1) } : {}),
    ...(geometryColor(raw.color) ? { color: geometryColor(raw.color) } : {}),
    ...(raw.material !== undefined ? { material: String(raw.material).slice(0, WORLD_GEOMETRY_LIMITS.maxLabelBytes) } : {})
  };
  return Object.freeze(result);
}

/**
 * Normalize geometry records produced by a future native/WASM decoder.
 *
 * The packed BZFlag database does not contain self-describing object records:
 * managers must be decoded in native order.  This adapter therefore accepts a
 * deliberately small object representation and validates it before it reaches
 * the renderer.  It is the stable boundary for a WASM/native decoder and does
 * not claim to decode compressed bytes by itself.
 */
export function normalizeWorldGeometry(input: unknown, options: Record<string, unknown> = {}): WorldGeometrySnapshot | null {
  if (!isRecord(input)) return null;
  const maxObjects = Math.min(
    WORLD_GEOMETRY_LIMITS.maxObjects,
    Math.max(1, Math.trunc(Number(options.maxObjects) || WORLD_GEOMETRY_LIMITS.maxObjects))
  );
  const sourceObjects: unknown[] = Array.isArray(input.objects) ? input.objects : [];
  const objects: WorldGeometryObject[] = [];
  for (const raw of sourceObjects) {
    if (objects.length >= maxObjects) break;
    const object = geometryObject(raw);
    if (object) objects.push(object);
  }
  const sourceValue = String(input.source || "unknown");
  const source: WorldGeometrySnapshot["source"] = sourceValue === "native-adapter" || sourceValue === "wasm-decoder" || sourceValue === "world-database"
    ? sourceValue
    : "unknown";
  const mapVersionValue = Number(input.mapVersion);
  return Object.freeze({
    version: 1,
    source,
    mapVersion: Number.isInteger(mapVersionValue) ? Math.max(0, Math.min(0xffff, mapVersionValue)) : null,
    objects: Object.freeze(objects),
    objectCount: objects.length
  });
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
  if (mapVersion !== WORLD_MAP_VERSION) {
    return invalidEnvelope(`Unsupported BZFlag world map version ${mapVersion}`);
  }
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
      geometryReady: false,
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
    objectDecoder: "native-bzflag-required",
    geometryReady: false
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

const WORLD_MANAGER_ORDER = Object.freeze([
  "dynamic-colors",
  "texture-matrices",
  "materials",
  "physics-drivers",
  "transforms",
  "obstacles",
  "teleporter-links",
  "water-level",
  "weapons",
  "entry-zones"
]);

const WORLD_OBSTACLE_KINDS = Object.freeze([
  "wall",
  "box",
  "pyramid",
  "base",
  "teleporter",
  "mesh",
  "arc",
  "cone",
  "sphere",
  "tetra"
]);

const TRANSFORM_NAMES = Object.freeze(["shift", "scale", "shear", "spin", "index"] as const);

type DecoderContext = {
  readonly reader: WorldByteReader;
  readonly limits: WorldDatabaseLimits;
  readonly materials: readonly WorldMaterialRecord[];
  obstacleTotal: number;
  readonly unsupported: WorldUnsupportedRecord[];
};

function readonlyArray<T>(values: T[]): readonly T[] {
  return Object.freeze(values.slice());
}

function readFloatArray(reader: WorldByteReader, count: number, label: string): number[] {
  const values: number[] = [];
  for (let i = 0; i < count; i += 1) values.push(reader.readFloat32(`${label}[${i}]`));
  return values;
}

function readColor(reader: WorldByteReader, label: string): GeometryColor {
  return [
    reader.readFloat32(`${label}.r`),
    reader.readFloat32(`${label}.g`),
    reader.readFloat32(`${label}.b`),
    reader.readFloat32(`${label}.a`)
  ];
}

function readDynamicColors(reader: WorldByteReader): WorldDynamicColorRecord[] {
  const colors: WorldDynamicColorRecord[] = [];
  const count = reader.readCount("dynamic-colors");
  for (let i = 0; i < count; i += 1) {
    const channels: WorldDynamicColorChannel[] = [];
    const name = reader.readString(`dynamic-colors[${i}].name`);
    for (let channel = 0; channel < 4; channel += 1) {
      const minimum = reader.readFloat32(`dynamic-colors[${i}].channels[${channel}].minimum`);
      const maximum = reader.readFloat32(`dynamic-colors[${i}].channels[${channel}].maximum`);
      const readWaves = (label: string): WorldDynamicColorWave[] => {
        const waveCount = reader.readCount(`dynamic-colors[${i}].channels[${channel}].${label}`);
        const waves: WorldDynamicColorWave[] = [];
        for (let wave = 0; wave < waveCount; wave += 1) {
          waves.push({
            period: reader.readFloat32(`${label}[${wave}].period`),
            offset: reader.readFloat32(`${label}[${wave}].offset`),
            weight: reader.readFloat32(`${label}[${wave}].weight`)
          });
        }
        return waves;
      };
      const sinusoids = readWaves("sinusoids");
      const clampUps = readWaves("clampUps");
      const clampDowns = readWaves("clampDowns");
      const sequenceCount = reader.readCount(
        `dynamic-colors[${i}].channels[${channel}].sequence`,
        reader.limits.maxDynamicSequences
      );
      const sequence: WorldDynamicColorChannel["sequence"] = sequenceCount > 0
        ? {
            count: sequenceCount,
            period: reader.readFloat32("dynamic-color.sequence.period"),
            offset: reader.readFloat32("dynamic-color.sequence.offset"),
            list: readonlyArray(Array.from(reader.readBytes(sequenceCount, "dynamic-color.sequence.list")))
          }
        : { count: 0, list: [] };
      channels.push({
        minimum,
        maximum,
        sinusoids: readonlyArray(sinusoids),
        clampUps: readonlyArray(clampUps),
        clampDowns: readonlyArray(clampDowns),
        sequence
      });
    }
    colors.push({ name, channels: readonlyArray(channels) });
  }
  return colors;
}

function readTextureMatrices(reader: WorldByteReader): WorldTextureMatrixRecord[] {
  const matrices: WorldTextureMatrixRecord[] = [];
  const count = reader.readCount("texture-matrices");
  for (let i = 0; i < count; i += 1) {
    const name = reader.readString(`texture-matrices[${i}].name`);
    const state = reader.readU8(`texture-matrices[${i}].state`);
    const record: WorldTextureMatrixRecord = {
      name,
      state,
      ...(state & 1 ? { staticValues: readonlyArray(readFloatArray(reader, 7, "texture-matrix.static")) } : {}),
      ...(state & 2 ? { dynamicValues: readonlyArray(readFloatArray(reader, 9, "texture-matrix.dynamic")) } : {})
    };
    matrices.push(record);
  }
  return matrices;
}

function readMaterials(reader: WorldByteReader): WorldMaterialRecord[] {
  const materials: WorldMaterialRecord[] = [];
  const count = reader.readCount("materials");
  for (let i = 0; i < count; i += 1) {
    const name = reader.readString(`materials[${i}].name`);
    const mode = reader.readU8(`materials[${i}].mode`);
    const dynamicColor = reader.readI32(`materials[${i}].dynamicColor`);
    const ambient = readColor(reader, "material.ambient");
    const diffuse = readColor(reader, "material.diffuse");
    const specular = readColor(reader, "material.specular");
    const emission = readColor(reader, "material.emission");
    const shininess = reader.readFloat32("material.shininess");
    const alphaThreshold = reader.readFloat32("material.alphaThreshold");
    const textureCount = reader.readU8(`materials[${i}].textureCount`);
    if (textureCount > reader.limits.maxMaterialTextures) {
      throw new WorldDecodeError("material texture count exceeds limit", reader.offset - 1);
    }
    const textures: WorldMaterialTexture[] = [];
    for (let texture = 0; texture < textureCount; texture += 1) {
      textures.push({
        name: reader.readString("material.texture.name"),
        matrix: reader.readI32("material.texture.matrix"),
        combineMode: reader.readI32("material.texture.combineMode"),
        state: reader.readU8("material.texture.state")
      });
    }
    const shaderCount = reader.readU8(`materials[${i}].shaderCount`);
    if (shaderCount > reader.limits.maxMaterialShaders) {
      throw new WorldDecodeError("material shader count exceeds limit", reader.offset - 1);
    }
    const shaders: string[] = [];
    for (let shader = 0; shader < shaderCount; shader += 1) shaders.push(reader.readString("material.shader"));
    materials.push({
      name,
      mode,
      dynamicColor,
      ambient,
      diffuse,
      specular,
      emission,
      shininess,
      alphaThreshold,
      textures: readonlyArray(textures),
      shaders: readonlyArray(shaders)
    });
  }
  return materials;
}

function readPhysicsDrivers(reader: WorldByteReader): WorldPhysicsDriverRecord[] {
  const drivers: WorldPhysicsDriverRecord[] = [];
  const count = reader.readCount("physics-drivers");
  for (let i = 0; i < count; i += 1) {
    drivers.push({
      name: reader.readString(`physics-drivers[${i}].name`),
      linear: reader.readVector3("physics-driver.linear"),
      angularVelocity: reader.readFloat32("physics-driver.angularVelocity"),
      angularPosition: [reader.readFloat32("physics-driver.angularPosition.x"), reader.readFloat32("physics-driver.angularPosition.y")],
      radialVelocity: reader.readFloat32("physics-driver.radialVelocity"),
      radialPosition: [reader.readFloat32("physics-driver.radialPosition.x"), reader.readFloat32("physics-driver.radialPosition.y")],
      slideTime: reader.readFloat32("physics-driver.slideTime"),
      deathMessage: reader.readString("physics-driver.deathMessage")
    });
  }
  return drivers;
}

function readTransforms(reader: WorldByteReader): WorldTransformRecord[] {
  const transforms: WorldTransformRecord[] = [];
  const count = reader.readCount("transforms");
  for (let i = 0; i < count; i += 1) {
    const name = reader.readString(`transforms[${i}].name`);
    const operationCount = reader.readCount(`transforms[${i}].operations`, reader.limits.maxTransforms);
    const operations: WorldTransformOperation[] = [];
    for (let operation = 0; operation < operationCount; operation += 1) {
      const type = reader.readU8("transform.type");
      if (type === 4) {
        operations.push({ type: TRANSFORM_NAMES[type], index: reader.readI32("transform.index") });
      } else if (type <= 2) {
        operations.push({ type: TRANSFORM_NAMES[type], vector: reader.readVector3("transform.vector") });
      } else if (type === 3) {
        operations.push({
          type: TRANSFORM_NAMES[type],
          vector: reader.readVector3("transform.spin.normal"),
          angle: reader.readFloat32("transform.spin.angle")
        });
      } else {
        throw new WorldDecodeError("unknown mesh transform type", reader.offset - 1);
      }
    }
    transforms.push({ name, operations: readonlyArray(operations) });
  }
  return transforms;
}

function readInlineTransform(reader: WorldByteReader): WorldTransformRecord {
  const name = reader.readString("obstacle-transform.name");
  const operationCount = reader.readCount("obstacle-transform.operations", reader.limits.maxTransforms);
  const operations: WorldTransformOperation[] = [];
  for (let operation = 0; operation < operationCount; operation += 1) {
    const type = reader.readU8("obstacle-transform.type");
    if (type === 4) {
      operations.push({ type: TRANSFORM_NAMES[type], index: reader.readI32("obstacle-transform.index") });
    } else if (type <= 2) {
      operations.push({ type: TRANSFORM_NAMES[type], vector: reader.readVector3("obstacle-transform.vector") });
    } else if (type === 3) {
      operations.push({
        type: TRANSFORM_NAMES[type],
        vector: reader.readVector3("obstacle-transform.spin.normal"),
        angle: reader.readFloat32("obstacle-transform.spin.angle")
      });
    } else {
      throw new WorldDecodeError("unknown obstacle transform type", reader.offset - 1);
    }
  }
  return { name, operations: readonlyArray(operations) };
}

function obstacleRecord(kind: string, index: number, supported: boolean, fields: Record<string, unknown>): WorldObstacleRecord {
  return Object.freeze({ kind, index, supported, ...fields });
}

function readMaterialIndices(reader: WorldByteReader, count: number, label: string): number[] {
  const values: number[] = [];
  for (let i = 0; i < count; i += 1) values.push(reader.readI32(`${label}[${i}]`));
  return values;
}

function readMesh(reader: WorldByteReader, index: number): WorldObstacleRecord {
  const checkCount = reader.readSignedCount("mesh.checks", reader.limits.maxMeshChecks);
  const checkTypes: number[] = [];
  const checkPoints: GeometryVector3[] = [];
  for (let i = 0; i < checkCount; i += 1) {
    checkTypes.push(reader.readU8("mesh.check.type"));
    checkPoints.push(reader.readVector3("mesh.check.point"));
  }

  const vertexCount = reader.readSignedCount("mesh.vertices", reader.limits.maxMeshVertices);
  const vertices: GeometryVector3[] = [];
  for (let i = 0; i < vertexCount; i += 1) vertices.push(reader.readVector3("mesh.vertex"));

  const normalCount = reader.readSignedCount("mesh.normals", reader.limits.maxMeshNormals);
  const normals: GeometryVector3[] = [];
  for (let i = 0; i < normalCount; i += 1) normals.push(reader.readVector3("mesh.normal"));

  const texcoordCount = reader.readSignedCount("mesh.texcoords", reader.limits.maxMeshTexcoords);
  // MeshDrawInfo is deliberately opaque.  Native BZFlag stores it in the
  // texture-coordinate byte region and the drawInfoOwner bit appears only
  // after the faces, so retain the exact bytes until that bit is available.
  const texcoordBytes = reader.readBytes(texcoordCount * 8, "mesh.texcoords");

  const faceSize = reader.readSignedCount("mesh.faces", reader.limits.maxMeshFaces);
  type Face = {
    state: number;
    vertices: number[];
    normals?: number[];
    texcoords?: number[];
    material: number;
    physicsDriver: number;
  };
  const faces: Face[] = [];
  for (let face = 0; face < faceSize; face += 1) {
    const state = reader.readU8("mesh.face.state");
    const faceVertexCount = reader.readSignedCount("mesh.face.vertices", reader.limits.maxFaceVertices);
    const verticesForFace = readMaterialIndices(reader, faceVertexCount, "mesh.face.vertex");
    const normalsForFace = state & 1 ? readMaterialIndices(reader, faceVertexCount, "mesh.face.normal") : undefined;
    const texcoordsForFace = state & 2 ? readMaterialIndices(reader, faceVertexCount, "mesh.face.texcoord") : undefined;
    faces.push({
      state,
      vertices: verticesForFace,
      ...(normalsForFace ? { normals: normalsForFace } : {}),
      ...(texcoordsForFace ? { texcoords: texcoordsForFace } : {}),
      material: reader.readI32("mesh.face.material"),
      physicsDriver: reader.readI32("mesh.face.physicsDriver")
    });
  }

  const state = reader.readU8("mesh.state");
  const drawInfoOwner = (state & (1 << 4)) !== 0;
  let realTexcoordCount = texcoordCount;
  let drawInfoBytes: Uint8Array | undefined;
  if (drawInfoOwner) {
    if (texcoordBytes.byteLength < 8) throw new WorldDecodeError("mesh draw-info region is truncated", reader.offset);
    const view = new DataView(texcoordBytes.buffer, texcoordBytes.byteOffset + texcoordBytes.byteLength - 8, 4);
    const rewindLength = view.getInt32(0, false);
    if (rewindLength < 8 || rewindLength % 8 !== 0 || rewindLength > texcoordBytes.byteLength) {
      throw new WorldDecodeError("mesh draw-info rewind length is invalid", reader.offset - 1);
    }
    const fakeTexcoords = rewindLength / 8;
    if (fakeTexcoords > texcoordCount) throw new WorldDecodeError("mesh draw-info texture count is invalid", reader.offset - 1);
    realTexcoordCount = texcoordCount - fakeTexcoords;
    drawInfoBytes = texcoordBytes.slice(texcoordBytes.byteLength - rewindLength, texcoordBytes.byteLength - 8);
  }

  const texcoords: [number, number][] = [];
  const texcoordView = new DataView(texcoordBytes.buffer, texcoordBytes.byteOffset, texcoordBytes.byteLength);
  for (let i = 0; i < realTexcoordCount; i += 1) {
    const byteOffset = i * 8;
    const u = texcoordView.getFloat32(byteOffset, false);
    const v = texcoordView.getFloat32(byteOffset + 4, false);
    if (!Number.isFinite(u) || !Number.isFinite(v)) throw new WorldDecodeError("mesh texture coordinate is non-finite", byteOffset);
    texcoords.push([u, v]);
  }

  for (const face of faces) {
    for (const vertex of face.vertices) if (vertex < 0 || vertex >= vertexCount) throw new WorldDecodeError("mesh face vertex reference is invalid", reader.offset);
    for (const normal of face.normals || []) if (normal < 0 || normal >= normalCount) throw new WorldDecodeError("mesh face normal reference is invalid", reader.offset);
    for (const texcoord of face.texcoords || []) if (texcoord < 0 || texcoord >= realTexcoordCount) throw new WorldDecodeError("mesh face texture reference is invalid", reader.offset);
  }

  return obstacleRecord("mesh", index, false, {
    checkTypes: readonlyArray(checkTypes),
    checkPoints: readonlyArray(checkPoints),
    vertices: readonlyArray(vertices),
    normals: readonlyArray(normals),
    texcoords: readonlyArray(texcoords),
    faces: readonlyArray(faces),
    state,
    drawInfoOwner,
    ...(drawInfoBytes ? { drawInfoBytes } : {})
  });
}

function readObstacle(reader: WorldByteReader, kind: string, index: number): WorldObstacleRecord {
  switch (kind) {
    case "wall": {
      const position = reader.readVector3("wall.position");
      const rotation = reader.readFloat32("wall.rotation");
      const breadth = reader.readFloat32("wall.breadth");
      const height = reader.readFloat32("wall.height");
      const state = reader.readU8("wall.state");
      return obstacleRecord(kind, index, true, {
        position,
        // The generic renderer has no plane primitive; retain a thin proxy
        // dimension while preserving the native breadth/height fields.
        size: [Math.max(0.01, Math.abs(breadth)), 0.01, Math.max(0.01, Math.abs(height))] as GeometryVector3,
        rotation,
        breadth,
        height,
        state,
        ricochet: (state & 8) !== 0
      });
    }
    case "box":
    case "pyramid": {
      const position = reader.readVector3(`${kind}.position`);
      const rotation = reader.readFloat32(`${kind}.rotation`);
      const size = reader.readVector3(`${kind}.size`);
      const state = reader.readU8(`${kind}.state`);
      return obstacleRecord(kind, index, true, {
        position,
        size,
        rotation,
        state,
        driveThrough: (state & 1) !== 0,
        shootThrough: (state & 2) !== 0,
        ...(kind === "pyramid" ? { flipZ: (state & 4) !== 0 } : {}),
        ricochet: (state & 8) !== 0
      });
    }
    case "base": {
      const team = reader.readU16("base.team");
      const position = reader.readVector3("base.position");
      const rotation = reader.readFloat32("base.rotation");
      const size = reader.readVector3("base.size");
      const state = reader.readU8("base.state");
      return obstacleRecord(kind, index, true, {
        team,
        position,
        size,
        rotation,
        state,
        driveThrough: (state & 1) !== 0,
        shootThrough: (state & 2) !== 0,
        ricochet: (state & 8) !== 0
      });
    }
    case "teleporter": {
      const name = reader.readString("teleporter.name");
      const position = reader.readVector3("teleporter.position");
      const rotation = reader.readFloat32("teleporter.rotation");
      const size = reader.readVector3("teleporter.size");
      const border = reader.readFloat32("teleporter.border");
      const horizontal = reader.readU8("teleporter.horizontal") !== 0;
      const state = reader.readU8("teleporter.state");
      return obstacleRecord(kind, index, true, {
        id: name,
        name,
        position,
        size,
        rotation,
        border,
        horizontal,
        state,
        driveThrough: (state & 1) !== 0,
        shootThrough: (state & 2) !== 0,
        ricochet: (state & 8) !== 0
      });
    }
    case "mesh":
      return readMesh(reader, index);
    case "arc": {
      const transform = readInlineTransform(reader);
      const position = reader.readVector3("arc.position");
      const size = reader.readVector3("arc.size");
      const rotation = reader.readFloat32("arc.rotation");
      const sweepAngle = reader.readFloat32("arc.sweepAngle");
      const ratio = reader.readFloat32("arc.ratio");
      const divisions = reader.readI32("arc.divisions");
      const physicsDriver = reader.readI32("arc.physicsDriver");
      const textureSize = readFloatArray(reader, 4, "arc.textureSize");
      const materials = readMaterialIndices(reader, 6, "arc.material");
      const state = reader.readU8("arc.state");
      return obstacleRecord(kind, index, false, {
        transform,
        position,
        size,
        rotation,
        sweepAngle,
        ratio,
        divisions,
        physicsDriver,
        textureSize: readonlyArray(textureSize),
        materials: readonlyArray(materials),
        state
      });
    }
    case "cone": {
      const transform = readInlineTransform(reader);
      const position = reader.readVector3("cone.position");
      const size = reader.readVector3("cone.size");
      const rotation = reader.readFloat32("cone.rotation");
      const sweepAngle = reader.readFloat32("cone.sweepAngle");
      const divisions = reader.readI32("cone.divisions");
      const physicsDriver = reader.readI32("cone.physicsDriver");
      const textureSize = readFloatArray(reader, 2, "cone.textureSize");
      const materials = readMaterialIndices(reader, 4, "cone.material");
      const state = reader.readU8("cone.state");
      return obstacleRecord(kind, index, false, {
        transform,
        position,
        size,
        rotation,
        sweepAngle,
        divisions,
        physicsDriver,
        textureSize: readonlyArray(textureSize),
        materials: readonlyArray(materials),
        state
      });
    }
    case "sphere": {
      const transform = readInlineTransform(reader);
      const position = reader.readVector3("sphere.position");
      const size = reader.readVector3("sphere.size");
      const rotation = reader.readFloat32("sphere.rotation");
      const divisions = reader.readI32("sphere.divisions");
      const physicsDriver = reader.readI32("sphere.physicsDriver");
      const textureSize = readFloatArray(reader, 2, "sphere.textureSize");
      const materials = readMaterialIndices(reader, 2, "sphere.material");
      const state = reader.readU8("sphere.state");
      return obstacleRecord(kind, index, false, {
        transform,
        position,
        size,
        rotation,
        divisions,
        physicsDriver,
        textureSize: readonlyArray(textureSize),
        materials: readonlyArray(materials),
        state,
        hemisphere: (state & (1 << 4)) !== 0
      });
    }
    case "tetra": {
      const state = reader.readU8("tetra.state");
      const transform = readInlineTransform(reader);
      const vertices: GeometryVector3[] = [];
      for (let i = 0; i < 4; i += 1) vertices.push(reader.readVector3("tetra.vertex"));
      const normalsMask = reader.readU8("tetra.normalsMask");
      const normals: GeometryVector3[][] = [];
      for (let vertex = 0; vertex < 4; vertex += 1) {
        if (normalsMask & (1 << vertex)) {
          const values: GeometryVector3[] = [];
          for (let i = 0; i < 3; i += 1) values.push(reader.readVector3("tetra.normal"));
          normals.push(values);
        } else normals.push([]);
      }
      const texcoordsMask = reader.readU8("tetra.texcoordsMask");
      const texcoords: [number, number][][] = [];
      for (let vertex = 0; vertex < 4; vertex += 1) {
        if (texcoordsMask & (1 << vertex)) {
          const values: [number, number][] = [];
          for (let i = 0; i < 3; i += 1) values.push(reader.readVector2("tetra.texcoord"));
          texcoords.push(values);
        } else texcoords.push([]);
      }
      const materials = readMaterialIndices(reader, 4, "tetra.material");
      return obstacleRecord(kind, index, false, {
        state,
        transform,
        vertices: readonlyArray(vertices),
        normals: readonlyArray(normals),
        texcoords: readonlyArray(texcoords),
        materials: readonlyArray(materials)
      });
    }
    default:
      throw new WorldDecodeError(`unknown obstacle kind ${kind}`, reader.offset);
  }
}

function addUnsupported(
  context: DecoderContext,
  manager: string,
  record: WorldObstacleRecord,
  reason: string
): void {
  context.unsupported.push({
    manager,
    kind: record.kind,
    index: record.index,
    reason,
    record
  });
}

function readObstacleLists(
  context: DecoderContext,
  manager: string
): { readonly lists: Readonly<Record<string, readonly WorldObstacleRecord[]>>; readonly flat: WorldObstacleRecord[] } {
  const lists: Record<string, readonly WorldObstacleRecord[]> = {};
  const flat: WorldObstacleRecord[] = [];
  for (const kind of WORLD_OBSTACLE_KINDS) {
    const count = context.reader.readCount(`${manager}.${kind}`, context.limits.maxObstacleEntries);
    const records: WorldObstacleRecord[] = [];
    if (context.obstacleTotal + count > context.limits.maxObstacleTotal) {
      throw new WorldDecodeError(`${manager} obstacle total exceeds limit`, context.reader.offset - 4);
    }
    for (let index = 0; index < count; index += 1) {
      const record = readObstacle(context.reader, kind, index);
      records.push(record);
      flat.push(record);
      context.obstacleTotal += 1;
      if (!record.supported) addUnsupported(context, manager, record, "obstacle kind is preserved but not rendered by the generic adapter");
    }
    lists[kind] = readonlyArray(records);
  }
  return { lists: Object.freeze(lists), flat };
}

function readGroupInstance(reader: WorldByteReader): WorldGroupInstanceRecord {
  const groupDefinition = reader.readString("group-instance.definition");
  const rawName = reader.readRawString("group-instance.name");
  const nul = rawName.bytes.indexOf(0);
  let name = rawName.text;
  const materialMappings: { source: number; destination: number }[] = [];
  if (nul >= 0) {
    name = new TextDecoder("utf-8", { fatal: false }).decode(rawName.bytes.slice(0, nul));
    const metadata = new WorldByteReader(rawName.bytes.slice(nul + 1), reader.limits);
    const mappingCount = metadata.readSignedCount("group-instance.materialMappings", reader.limits.maxMaterialMappings);
    for (let i = 0; i < mappingCount; i += 1) {
      materialMappings.push({ source: metadata.readI32("group-instance.material.source"), destination: metadata.readI32("group-instance.material.destination") });
    }
    if (metadata.remaining !== 0) throw new WorldDecodeError("group-instance material mapping has trailing bytes", reader.offset);
  }
  const transform = readInlineTransform(reader);
  const flags = reader.readU8("group-instance.flags");
  const record: WorldGroupInstanceRecord = {
    groupDefinition,
    name,
    materialMappings: readonlyArray(materialMappings),
    transform,
    flags,
    ...(flags & 1 ? { team: reader.readU16("group-instance.team") } : {}),
    ...(flags & 2 ? { tint: [
      reader.readFloat32("group-instance.tint.r"),
      reader.readFloat32("group-instance.tint.g"),
      reader.readFloat32("group-instance.tint.b"),
      reader.readFloat32("group-instance.tint.a")
    ] as [number, number, number, number] } : {}),
    ...(flags & 4 ? { physicsDriver: reader.readI32("group-instance.physicsDriver") } : {}),
    ...(flags & 8 ? { material: reader.readI32("group-instance.material") } : {})
  };
  return record;
}

function readGroupDefinitions(context: DecoderContext): WorldGroupDefinitionRecord[] {
  const definitions: WorldGroupDefinitionRecord[] = [];
  const count = context.reader.readCount("group-definitions", context.limits.maxGroupDefinitions);
  for (let index = 0; index < count; index += 1) {
    const name = context.reader.readString(`group-definitions[${index}].name`);
    const nested = readObstacleLists(context, `group-definitions[${index}]`);
    const instanceCount = context.reader.readCount(`group-definitions[${index}].instances`, context.limits.maxGroupInstances);
    const instances: WorldGroupInstanceRecord[] = [];
    for (let instance = 0; instance < instanceCount; instance += 1) {
      instances.push(readGroupInstance(context.reader));
    }
    const definition = {
      name,
      obstacles: nested.lists,
      instances: readonlyArray(instances)
    };
    definitions.push(definition);
    context.unsupported.push({
      manager: "group-definitions",
      kind: "group-definition",
      index,
      reason: "group expansion and native transform/material modifiers are not rendered by the generic adapter",
      record: definition
    });
  }
  return definitions;
}

function readLinks(reader: WorldByteReader): WorldLinkRecord[] {
  const links: WorldLinkRecord[] = [];
  const count = reader.readCount("teleporter-links");
  for (let i = 0; i < count; i += 1) {
    links.push({
      source: reader.readString("teleporter-link.source"),
      destination: reader.readString("teleporter-link.destination")
    });
  }
  return links;
}

function readFlagType(reader: WorldByteReader, label: string): string {
  return new TextDecoder("ascii", { fatal: false }).decode(reader.readBytes(2, label));
}

function readWeapons(reader: WorldByteReader): WorldWeaponRecord[] {
  const weapons: WorldWeaponRecord[] = [];
  const count = reader.readCount("weapons", reader.limits.maxWeapons);
  for (let i = 0; i < count; i += 1) {
    const flagType = readFlagType(reader, "world-weapon.flagType");
    const origin = reader.readVector3("world-weapon.origin");
    const direction = reader.readFloat32("world-weapon.direction");
    const initialDelay = reader.readFloat32("world-weapon.initialDelay");
    const delayCount = reader.readU16("world-weapon.delayCount");
    if (delayCount > reader.limits.maxWeaponDelays) throw new WorldDecodeError("world weapon delay count exceeds limit", reader.offset - 2);
    weapons.push({
      flagType,
      origin,
      direction,
      initialDelay,
      delays: readonlyArray(readFloatArray(reader, delayCount, "world-weapon.delay"))
    });
  }
  return weapons;
}

function readEntryZones(reader: WorldByteReader): WorldEntryZoneRecord[] {
  const zones: WorldEntryZoneRecord[] = [];
  const count = reader.readCount("entry-zones", reader.limits.maxEntryZones);
  for (let i = 0; i < count; i += 1) {
    const position = reader.readVector3("entry-zone.position");
    const size = reader.readVector3("entry-zone.size");
    const rotation = reader.readFloat32("entry-zone.rotation");
    const flagCount = reader.readU16("entry-zone.flagCount");
    const teamCount = reader.readU16("entry-zone.teamCount");
    const safetyCount = reader.readU16("entry-zone.safetyCount");
    if (flagCount > reader.limits.maxZoneEntries || teamCount > reader.limits.maxZoneEntries || safetyCount > reader.limits.maxZoneEntries) {
      throw new WorldDecodeError("entry-zone member count exceeds limit", reader.offset - 6);
    }
    const flags: string[] = [];
    for (let flag = 0; flag < flagCount; flag += 1) flags.push(readFlagType(reader, "entry-zone.flag"));
    const teams: number[] = [];
    for (let team = 0; team < teamCount; team += 1) teams.push(reader.readU16("entry-zone.team"));
    const safetyTeams: number[] = [];
    for (let safety = 0; safety < safetyCount; safety += 1) safetyTeams.push(reader.readU16("entry-zone.safetyTeam"));
    zones.push({
      position,
      size,
      rotation,
      flags: readonlyArray(flags),
      teams: readonlyArray(teams),
      safetyTeams: readonlyArray(safetyTeams)
    });
  }
  return zones;
}

function makeDatabaseObjects(obstacles: readonly WorldObstacleRecord[]): WorldGeometryObject[] {
  const objects: WorldGeometryObject[] = [];
  for (const obstacle of obstacles) {
    if (!obstacle.supported) continue;
    const object = geometryObject({
      kind: obstacle.kind,
      id: obstacle.id ?? `${obstacle.kind}-${obstacle.index}`,
      position: obstacle.position,
      size: obstacle.size,
      rotation: obstacle.rotation,
      team: obstacle.team
    });
    if (object) objects.push(object);
  }
  return objects;
}

/**
 * Decode the uncompressed native BZFS manager stream.  The stream has no
 * object tags; its only valid interpretation is the exact order emitted by
 * WorldInfo::packDatabase() and consumed by WorldBuilder::unpack().
 */
export function decodeWorldDatabase(input: unknown, options: Record<string, unknown> = {}): WorldDatabaseSnapshot {
  let bytes: Uint8Array;
  try {
    bytes = toUint8Array(input);
  } catch (error) {
    throw new WorldDecodeError(error instanceof Error ? error.message : "Invalid BZFlag world database bytes", 0);
  }
  const requestedMapVersion = options.mapVersion === undefined ? WORLD_MAP_VERSION : Number(options.mapVersion);
  if (requestedMapVersion !== WORLD_MAP_VERSION) throw new Error(`Unsupported BZFlag map version ${String(options.mapVersion)}`);
  const limits = clampDatabaseLimits(options);
  const reader = new WorldByteReader(bytes, limits);
  const unsupported: WorldUnsupportedRecord[] = [];
  const dynamicColors = readDynamicColors(reader);
  const textureMatrices = readTextureMatrices(reader);
  const materials = readMaterials(reader);
  const physicsDrivers = readPhysicsDrivers(reader);
  const transforms = readTransforms(reader);
  const context: DecoderContext = {
    reader,
    limits,
    materials,
    obstacleTotal: 0,
    unsupported
  };
  const root = readObstacleLists(context, "obstacles");
  const groupDefinitions = readGroupDefinitions(context);
  const links = readLinks(reader);
  const waterLevel = reader.readFloat32("water.level");
  const waterMaterialIndex = waterLevel >= 0 ? reader.readI32("water.material") : null;
  const weapons = readWeapons(reader);
  const entryZones = readEntryZones(reader);
  if (reader.remaining !== 0) throw new WorldDecodeError("world manager stream has trailing bytes", reader.offset);

  const objects = makeDatabaseObjects(root.flat);
  const snapshot: WorldDatabaseSnapshot = {
    valid: true,
    version: 1,
    source: "world-database",
    mapVersion: WORLD_MAP_VERSION,
    decoder: "typescript-native",
    geometryReady: true,
    objects: readonlyArray(objects),
    objectCount: objects.length,
    consumedBytes: bytes.byteLength,
    uncompressedBytes: Number.isInteger(Number(options.uncompressedBytes)) ? Number(options.uncompressedBytes) : bytes.byteLength,
    managerOrder: WORLD_MANAGER_ORDER,
    dynamicColors: readonlyArray(dynamicColors),
    textureMatrices: readonlyArray(textureMatrices),
    materials: readonlyArray(materials),
    physicsDrivers: readonlyArray(physicsDrivers),
    transforms: readonlyArray(transforms),
    obstacles: readonlyArray(root.flat),
    links: readonlyArray(links),
    water: Object.freeze({ level: waterLevel, materialIndex: waterMaterialIndex }),
    weapons: readonlyArray(weapons),
    entryZones: readonlyArray(entryZones),
    groupDefinitions: readonlyArray(groupDefinitions),
    unsupported: readonlyArray(unsupported)
  };
  return Object.freeze(snapshot);
}

/** Compatibility alias for callers that name the native stream explicitly. */
export const parseWorldDatabase = decodeWorldDatabase;

/** Decode a validated compressed BZFS envelope and its complete manager stream. */
export async function decodeWorldEnvelope(
  envelope: WorldEnvelope,
  options: Record<string, unknown> = {}
): Promise<WorldDatabaseSnapshot> {
  if (!envelope?.valid || !envelope.compressed) throw new Error("A valid BZFlag world envelope is required");
  if (envelope.mapVersion !== WORLD_MAP_VERSION) throw new Error(`Unsupported BZFlag map version ${String(envelope.mapVersion)}`);
  const bytes = await decompressWorldEnvelope(envelope, options);
  return decodeWorldDatabase(bytes, {
    ...options,
    mapVersion: envelope.mapVersion,
    uncompressedBytes: envelope.uncompressedBytes
  });
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
  WORLD_MAP_VERSION,
  WORLD_HEADER_BYTES,
  WORLD_FOOTER_BYTES,
  WORLD_HEADER_LENGTH,
  WORLD_END_LENGTH,
  DEFAULT_WORLD_LIMITS,
  parseWorldEnvelope,
  summarizeWorldEnvelope,
  WORLD_GEOMETRY_KINDS,
  WORLD_GEOMETRY_LIMITS,
  normalizeWorldGeometry,
  DEFAULT_WORLD_DATABASE_LIMITS,
  WorldDecodeError,
  WorldByteReader,
  decodeWorldDatabase,
  parseWorldDatabase,
  decodeWorldEnvelope,
  decompressWorldEnvelope,
  WorldTransferAssembler,
  createWorldTransferAssembler
};

if (typeof globalThis !== "undefined") {
  (globalThis as typeof globalThis & { BZFlagWebWorld?: typeof api }).BZFlagWebWorld = api;
}

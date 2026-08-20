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

interface BZFlagWebRendererHandle {
  mode: string;
  setWorldState?: (state: unknown) => void;
  handleInput?: (command: string, phase: string) => void;
  stop?: () => void;
}

interface BZFlagWebProtocolResult {
  valid?: boolean;
  code?: number;
  channel?: number;
  data?: Record<string, unknown>;
  player?: Record<string, unknown>;
  local?: boolean;
  [key: string]: unknown;
}

interface BZFlagWebProtocolApi {
  PLAYER_STATUS?: { dead?: number; [key: string]: number | undefined };
  MAX_WORLD_BYTES: number;
  DEFAULT_SERVER_VERSION: string;
  MSG_ACCEPT: number;
  MSG_NEGOTIATE_FLAGS: number;
  MSG_GAME_SETTINGS: number;
  MSG_WANT_W_HASH: number;
  MSG_WANT_SETTINGS: number;
  MSG_GET_WORLD: number;
  MSG_UDP_LINK_REQUEST: number;
  MSG_UDP_LINK_ESTABLISHED: number;
  MSG_PLAYER_UPDATE: number;
  MSG_PLAYER_UPDATE_SMALL: number;
  MSG_ALIVE: number;
  MSG_SUPER_KILL: number;
  encodeConnectHeader?: () => Uint8Array;
  encodeEnter?: (connection?: Record<string, unknown>) => Uint8Array;
  encodeInput?: (command: string, phase: string, key: string, state?: Record<string, unknown>) => Uint8Array | null;
  encodeUDPLinkRequest?: (playerId: number) => Uint8Array;
  encodeUDPLinkEstablished?: () => Uint8Array;
  encodeFlagNegotiation?: () => Uint8Array;
  encodeQueryGame?: () => Uint8Array;
  encodeQueryPlayers?: () => Uint8Array;
  encodeNoPayload?: (code: number) => Uint8Array;
  encodeGetWorld?: (offset: number) => Uint8Array;
  consume?: (channel: number, payload: Uint8Array, options?: Record<string, unknown>) => BZFlagWebProtocolResult;
  ServerHandshake: new (options?: { expectedVersion?: string }) => {
    playerId?: number;
    push(payload: Uint8Array): { ready: boolean; version?: string; playerId?: number; payload: Uint8Array };
  };
  PacketStream: new () => { push(payload: Uint8Array): Uint8Array[] };
  [key: string]: unknown;
}

interface Window {
  BZFlagWebClient?: Record<string, unknown>;
  BZFlagWebGame?: { worldState?: unknown; [key: string]: unknown };
  BZFlagWebI18n?: { t: (key: string | null) => string; [key: string]: unknown };
  BZFlagWebProtocol?: BZFlagWebProtocolApi;
  BZFlagWebRenderer?: {
    createRenderer: (canvas: HTMLCanvasElement | null, options?: Record<string, unknown>) => Promise<BZFlagWebRendererHandle>;
    [key: string]: unknown;
  };
  webkitAudioContext?: typeof AudioContext;
}

interface Navigator {
  gpu?: GPU;
}

interface GPU {
  requestAdapter(): Promise<GPUAdapter | null>;
}

type GPUAdapter = any;
type GPUDevice = any;
type GPUCanvasContext = any;
type GPUTexture = any;
type GPUBuffer = any;
type GPURenderPipeline = any;
type GPUBindGroup = any;
type GPUShaderModule = any;
type GPUCommandEncoder = any;
type GPUTextureFormat = string;

declare const GPUBufferUsage: { VERTEX: number; UNIFORM: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number };

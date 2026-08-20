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

interface Window {
  BZFlagWebClient?: Record<string, unknown>;
  BZFlagWebGame?: Record<string, unknown>;
  BZFlagWebI18n?: { t: (key: string) => string } & Record<string, unknown>;
  BZFlagWebProtocol?: {
    encodeEnter?: (connection?: Record<string, unknown>) => Uint8Array;
    encodeInput?: (command: string, phase: string, key: string) => Uint8Array | null;
    consume?: (channel: number, payload: Uint8Array) => unknown;
  } & Record<string, unknown>;
  BZFlagWebRenderer?: {
    createRenderer: (canvas: HTMLCanvasElement | null, options?: Record<string, unknown>) => Promise<{ mode: string; stop?: () => void }>;
  } & Record<string, unknown>;
  webkitAudioContext?: typeof AudioContext;
}

interface Navigator {
  gpu?: any;
}

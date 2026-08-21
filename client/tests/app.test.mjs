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
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = await readFile(join(root, "dist/app.js"), "utf8");
const values = new Map([
  ["bzflag-web.preferences.v1", JSON.stringify({ nickname: "Saved player", rememberPassword: true, password: "secret" })]
]);
const storage = {
  getItem(key) { return values.get(key) ?? null; },
  setItem(key, value) { values.set(key, String(value)); },
  removeItem(key) { values.delete(key); }
};

function element(id, initial = {}) {
  const listeners = new Map();
  return {
    id,
    value: "",
    checked: false,
    hidden: false,
    dataset: {},
    selectedOptions: [],
    className: "",
    textContent: "",
    innerHTML: "",
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatch(type, event = {}) { return listeners.get(type)?.(event); },
    querySelector() { return null; },
    checkValidity() { return true; },
    reportValidity() {},
    ...initial
  };
}

const elements = new Map([
  ["connect-form", element("connect-form")],
  ["connect-status", element("connect-status")],
  ["nickname", element("nickname")],
  ["server-host", element("server-host")],
  ["server-id", element("server-id")],
  ["server-preset", element("server-preset")],
  ["server-port", element("server-port")],
  ["gateway-endpoint", element("gateway-endpoint", { value: "/bridge" })],
  ["session-token", element("session-token")],
  ["password", element("password")],
  ["remember-password", element("remember-password")],
  ["team", element("team")],
  ["motto", element("motto")],
  ["audio-enabled", element("audio-enabled", { checked: true })],
  ["prefer-webgpu", element("prefer-webgpu", { checked: true })],
  ["install-button", element("install-button")],
  ["client-credit", element("client-credit")]
]);
const documentListeners = new Map();
const windowListeners = new Map();
const serviceWorkerCalls = [];
const form = elements.get("connect-form");
form.querySelector = () => element("submit-button", { disabled: false });
const document = {
  documentElement: { dataset: { page: "connect" }, lang: "" },
  getElementById(id) { return elements.get(id) ?? null; },
  addEventListener(type, listener) { documentListeners.set(type, listener); }
};
const context = {
  document,
  navigator: {
    serviceWorker: { register: async (...args) => { serviceWorkerCalls.push(args); } }
  },
  window: {
    localStorage: storage,
    sessionStorage: storage,
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    setTimeout,
    location: { assign() {} }
  }
};
context.window.BZFlagWebI18n = { t: (key) => key };
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "dist/app.js" });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

documentListeners.get("DOMContentLoaded")();
assert(elements.get("password").value === "secret", "opt-in password was not restored from localStorage");
assert(serviceWorkerCalls[0]?.[0] === "./service-worker.js", "service worker registration is not relative");
assert(serviceWorkerCalls[0]?.[1]?.scope === "./", "service worker scope is not relative");
assert(context.window.BZFlagWebClient.normaliseGatewayEndpoint("//external.example/bridge") === "", "protocol-relative gateway endpoint was accepted");
assert(context.window.BZFlagWebClient.normaliseGatewayEndpoint("/bridge") === "/bridge", "relative gateway endpoint was rejected");
assert(context.window.BZFlagWebClient.normaliseGatewayEndpoint("ws://[::1]:8080/bridge") === "ws://[::1]:8080/bridge", "IPv6 gateway endpoint was rejected");

const remember = elements.get("remember-password");
remember.checked = false;
remember.dispatch("change");
const cleared = JSON.parse(values.get("bzflag-web.preferences.v1"));
assert(cleared.password === undefined && cleared.rememberPassword === false, "disabling password persistence did not clear localStorage");

const installButton = elements.get("install-button");
let prompted = false;
const installEvent = {
  preventDefault() {},
  async prompt() { prompted = true; },
  userChoice: Promise.resolve({ outcome: "accepted" })
};
windowListeners.get("beforeinstallprompt")(installEvent);
assert(installButton.hidden === false, "install button did not appear after beforeinstallprompt");
await installButton.dispatch("click");
assert(prompted && installButton.hidden === true, "PWA install prompt was not completed");

console.log("Client app checks passed (relative gateway, opt-in password storage and PWA install prompt).");

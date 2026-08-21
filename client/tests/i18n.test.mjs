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

import { access, readFile } from "node:fs/promises";
import vm from "node:vm";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = await readFile(join(root, "dist/i18n.js"), "utf8");
const values = new Map([["bzflag-web.locale.v1", "en-US"]]);
const events = [];
const storage = {
  getItem(key) {
    return values.get(key) ?? null;
  },
  setItem(key, value) {
    values.set(key, String(value));
  }
};
const document = {
  documentElement: { lang: "" },
  addEventListener() {},
  dispatchEvent(event) {
    events.push(event);
  },
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  }
};
const context = {
  CustomEvent: class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  },
  document,
  navigator: { language: "en-US" },
  fetch: async (url) => ({
    ok: true,
    text: async () => String(url).includes("bzflag_it.po")
      ? 'msgid "Connect"\nmsgstr "Connetti"\n\nmsgid "Disconnect"\nmsgstr "Disconnetti"\n'
      : ""
  }),
  window: { localStorage: storage }
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "dist/i18n.js" });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const i18n = context.window.BZFlagWebI18n;
assert(i18n.DEFAULT_LOCALE === "en", "English fallback locale changed");
assert(i18n.SUPPORTED_LOCALES.length === 16, "upstream locale count changed");
assert(new Set(i18n.SUPPORTED_LOCALES).size === 16, "upstream locale list contains duplicates");
assert(Object.keys(i18n.LOCALE_CATALOGS).length === 16, "locale catalog map is incomplete");
assert(i18n.normaliseLocale("en-US") === "en", "plain browser English must not become l33t English");
assert(i18n.normaliseLocale("en_US_l33t") === "en_US_l33t", "l33t locale alias changed");
assert(i18n.normaliseLocale("en-US-l33t") === "en_US_l33t", "hyphenated l33t locale alias changed");
assert(i18n.normaliseLocale("cs-CZ") === "cs_CZ", "hyphenated Czech locale alias changed");
assert(i18n.normaliseLocale("it-IT") === "it", "Italian locale fallback changed");
assert(i18n.toLanguageTag("cs_CZ") === "cs-CZ", "locale was not converted to a language tag");
for (const locale of i18n.SUPPORTED_LOCALES) {
  assert(i18n.LOCALE_PACKS[locale]?.installApp, `${locale} locale is missing the PWA install label`);
}

for (const locale of i18n.SUPPORTED_LOCALES) {
  const path = i18n.LOCALE_CATALOGS[locale];
  assert(typeof path === "string" && path.startsWith("./assets/upstream/l10n/"), `${locale} catalog path is not relative`);
  await access(join(root, path.slice(2)));
}

await i18n.setLocale("it");
assert(i18n.getLocale() === "it", "Italian locale was not selected");
assert(i18n.t("connect") === "Connetti", "Italian runtime translation is missing");
assert(document.documentElement.lang === "it", "Italian language tag is incorrect");
await i18n.setLocale("en");
assert(i18n.getLocale() === "en", "English fallback cannot be selected");
assert(i18n.t("connect") === "Connect", "English fallback translation is missing");
assert(events.at(-1)?.detail?.locale === "en", "locale change event did not expose the active locale");

console.log("Client i18n checks passed (16 upstream catalogues, English fallback and locale tags).");

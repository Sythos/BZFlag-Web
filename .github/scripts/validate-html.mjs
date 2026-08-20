/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) Sythos (https://www.sythos.net)
 *
 * MIT License
 *
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
 *
 * Small, dependency-free smoke checks for the public HTML entry points. The
 * browser client is intentionally static, so these checks run on every
 * supported runner without a DOM package or a browser installation.
 */

import { access, readFile } from "node:fs/promises";

const files = [
  ["server/index.html", ["Sythos (https://www.sythos.net)", "Node.js 26", "gateway"]],
  ["client/index.html", ["Sythos (https://www.sythos.net)", "F11", "BZFS", "connect"]],
  ["client/web_game_run.html", ["Sythos (https://www.sythos.net)", "BZFS"]],
];

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const failures = [];
let checked = 0;

for (const [path, requiredText] of files) {
  if (!(await exists(path))) {
    continue;
  }

  checked += 1;
  const source = await readFile(path, "utf8");
  const normalized = source.toLowerCase();

  for (const token of ["<!doctype html", "<html", "</html>", "<head", "</head>", "<body", "</body>", "<title"] ) {
    if (!normalized.includes(token)) {
      failures.push(`${path}: missing required HTML token ${token}`);
    }
  }

  for (const token of requiredText) {
    if (!normalized.includes(token.toLowerCase())) {
      failures.push(`${path}: missing required project marker ${token}`);
    }
  }

  const footer = source.match(/<footer\b[\s\S]*?<\/footer>/i)?.[0] || "";
  if (path === "client/index.html" || path === "server/index.html") {
    const creditLinkPattern = /<a\b[^>]*\bhref\s*=\s*(["'])https:\/\/www\.sythos\.net\/\1[^>]*>/i;
    if (!creditLinkPattern.test(footer)) {
      failures.push(`${path}: the bottom-right credit must link to https://www.sythos.net/`);
    }
  }

  const operationalMarkup = source.replace(/<footer\b[\s\S]*?<\/footer>/gi, "");
  for (const match of operationalMarkup.matchAll(/(?:href|src|content|data-brand-source)\s*=\s*["']https:\/\/www\.sythos\.net[^"']*["']/gi)) {
    failures.push(`${path}: operational branding references must be relative: ${match[0]}`);
  }
}

if (checked === 0) {
  console.log("No server/client HTML entry points are present yet; HTML smoke checks skipped.");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else if (checked > 0) {
  console.log(`Validated ${checked} server/client HTML entry point(s).`);
}

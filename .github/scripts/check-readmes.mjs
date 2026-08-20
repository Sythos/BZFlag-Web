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
 *
 * Validate every README.md published by this repository. The upstream asset
 * manifest is included in the structural check; its upstream provenance content
 * remains unchanged apart from the approved arrow-heading normalization.
 */

import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const publishableReadmes = [
  "README.md",
  "server/README.md",
  "client/README.md",
  "client/assets/upstream/README.md",
];
const failures = [];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function checkRelativeLinks(path, source) {
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of source.matchAll(linkPattern)) {
    const target = match[1].trim().replace(/^<|>$/g, "");
    if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
    if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(target)) {
      failures.push(`${path}: local README reference must be relative: ${target}`);
      continue;
    }
    const localTarget = target.split(/[?#]/, 1)[0];
    if (!localTarget) continue;
    const resolvedTarget = resolve(dirname(path), localTarget);
    if (!(await exists(resolvedTarget))) {
      failures.push(`${path}: local README reference does not exist: ${target}`);
    }
  }
}

for (const path of publishableReadmes) {
  if (!(await exists(path))) {
    failures.push(`${path}: required publishable README is missing`);
    continue;
  }

  const source = await readFile(path, "utf8");
  const lines = source.split(/\r?\n/);
  const lower = source.toLowerCase();

  const identityMarker = path === "client/assets/upstream/README.md" ? "upstream bzflag" : "bzflag web";
  if (!lower.includes(identityMarker)) failures.push(`${path}: missing project identity`);
  if (!lines.some((line) => /^=>\s+/.test(line))) {
    failures.push(`${path}: missing arrow-style document heading`);
  }
  if (lines.some((line) => /^\s*#{1,6}\s+/.test(line))) {
    failures.push(`${path}: Markdown hash headings are not permitted`);
  }
  if (lines.some((line) => /^\s*-\s+/.test(line))) {
    failures.push(`${path}: hyphen-prefixed Markdown list items are not permitted`);
  }
  if (/(?:^|[\s(])[A-Za-z]:[\\/]/.test(source)) {
    failures.push(`${path}: machine-specific absolute path detected`);
  }

  await checkRelativeLinks(path, source);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated publishable README files: ${publishableReadmes.join(", ")}.`);
  console.log("The upstream asset manifest was checked structurally without changing its provenance content.");
}

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
 * Validate the server Docker build context before Docker is invoked. This
 * catches root-context/COPY drift and prevents a release from silently
 * depending on files outside the standalone server package.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

const repositoryRoot = resolve(process.cwd());
const contextRoot = resolve(repositoryRoot, "server");
const dockerfilePath = resolve(contextRoot, "Dockerfile");
const failures = [];

function failure(message) {
  failures.push(message);
}

function isInsideContext(path) {
  const target = resolve(path);
  return target === contextRoot || target.startsWith(`${contextRoot}${sep}`);
}

async function checkContextFile(source, lineNumber) {
  if (!source || source === ".") return;
  if (source.startsWith("/") || source.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(source) || source.split(/[\\/]/).includes("..")) {
    failure(`server/Dockerfile:${lineNumber}: COPY source must remain relative to server/: ${source}`);
    return;
  }
  const candidate = resolve(contextRoot, source);
  if (!isInsideContext(candidate)) {
    failure(`server/Dockerfile:${lineNumber}: COPY source escapes server/: ${source}`);
    return;
  }
  try {
    const resolved = await realpath(candidate);
    if (!isInsideContext(resolved)) failure(`server/Dockerfile:${lineNumber}: COPY source resolves outside server/: ${source}`);
    else if (!(await stat(resolved)).isFile() && !(await stat(resolved)).isDirectory()) failure(`server/Dockerfile:${lineNumber}: COPY source is not a file or directory: ${source}`);
  } catch {
    failure(`server/Dockerfile:${lineNumber}: COPY source is missing from server/ context: ${source}`);
  }
}

try {
  const dockerfile = await readFile(dockerfilePath, "utf8");
  if (!/FROM\s+node:26\.7\.0-alpine\b/i.test(dockerfile)) failure("server/Dockerfile: Node 26.7.0 Alpine is required for the gateway build and runtime stages");
  if (/gateway\.mjs/i.test(dockerfile)) failure("server/Dockerfile: legacy gateway.mjs reference is not allowed");
  if (!/CMD\s+\[\s*["']node["']\s*,\s*["']gateway\.js["']\s*\]/i.test(dockerfile)) failure("server/Dockerfile: gateway.js must be the runtime entrypoint");

  for (const [index, rawLine] of dockerfile.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!/^COPY\s+/i.test(line) || /--from=/i.test(line)) continue;
    const tokens = line.replace(/^COPY\s+/i, "").replace(/\s+#.*$/, "").trim().split(/\s+/);
    if (tokens.length < 2) {
      failure(`server/Dockerfile:${index + 1}: COPY instruction has no source and destination`);
      continue;
    }
    for (const source of tokens.slice(0, -1)) await checkContextFile(source, index + 1);
  }
} catch (error) {
  failure(`server/Dockerfile: cannot read Docker build context (${error.code || error.message})`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Docker context is relative, self-contained and aligned with the Node 26.7.0 gateway entrypoint.");
}

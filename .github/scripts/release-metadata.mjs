/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Sythos (https://www.sythos.net)
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
 * Build deterministic release metadata only after the package and container
 * artifacts have passed their gates. The upstream revision is read from the
 * repository manifest rather than inferred from the web repository commit.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = process.cwd();

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function git(args) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const releaseTag = option("--release-tag") || process.env.RELEASE_TAG;
const releaseDirectory = option("--release-dir") || "release";
assert(releaseTag, "A release tag is required");
assert(/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(releaseTag), `Invalid release tag: ${releaseTag}`);

const rootPackage = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
const upstream = rootPackage["x-upstream"];
assert(upstream && typeof upstream === "object", "package.json x-upstream metadata is required");
assert(upstream.project === "BZFlag", "x-upstream.project must be BZFlag");
assert(upstream.repository === "https://github.com/BZFlag-Dev/bzflag", "x-upstream.repository is invalid");
assert(/^[0-9a-f]{40}$/i.test(String(upstream.ref || "")), "x-upstream.ref must be a full commit SHA");
assert(String(upstream.version || "").trim(), "x-upstream.version is required");
assert(String(upstream.branch || "").trim(), "x-upstream.branch is required");

const releaseCommit = git(["rev-parse", "--verify", `${releaseTag}^{commit}`]);
const checkoutCommit = git(["rev-parse", "--verify", "HEAD"]);
assert(releaseCommit === checkoutCommit, `Checked-out commit ${checkoutCommit} does not match ${releaseTag} commit ${releaseCommit}`);

const releaseRoot = resolve(repositoryRoot, releaseDirectory);
const clientDirectory = resolve(releaseRoot, `bzflag-web-client-${releaseTag.slice(1)}`);
const serverDirectory = resolve(releaseRoot, `bzflag-web-server-${releaseTag.slice(1)}`);
await mkdir(releaseRoot, { recursive: true });

for (const [path, marker] of [[clientDirectory, "client"], [serverDirectory, "server"]]) {
  try {
    assert((await stat(path)).isDirectory(), `Release ${marker} directory is missing: ${path}`);
  } catch (error) {
    throw new Error(`Release ${marker} directory is missing: ${path} (${error.message})`);
  }
}
for (const [path, marker] of [[`${clientDirectory}/dist`, "client/dist"], [`${serverDirectory}/dist`, "server/dist"]]) {
  try {
    assert((await stat(path)).isDirectory(), `Release ${marker} build output is missing: ${path}`);
  } catch (error) {
    throw new Error(`Release ${marker} build output is missing: ${path} (${error.message})`);
  }
}

const generatedAt = new Date().toISOString();
const repository = process.env.GITHUB_REPOSITORY || "Sythos/BZFlag-Web";
const releaseUrl = `https://github.com/${repository}/releases/tag/${releaseTag}`;
const upstreamRecord = {
  project: upstream.project,
  version: upstream.version,
  branch: upstream.branch,
  ref: upstream.ref,
  repository: upstream.repository,
};

const manifest = [
  "BZFlag Web Client release manifest",
  `Release tag: ${releaseTag}`,
  `Release commit: ${releaseCommit}`,
  `Upstream project: ${upstreamRecord.project}`,
  `Upstream version: ${upstreamRecord.version}`,
  `Upstream branch: ${upstreamRecord.branch}`,
  `Upstream ref: ${upstreamRecord.ref}`,
  `Upstream repository: ${upstreamRecord.repository}`,
  `Generated at: ${generatedAt}`,
  "",
].join("\n");
await writeFile(resolve(releaseRoot, "RELEASE-MANIFEST.txt"), manifest, "utf8");

const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `bzflag-web-${releaseTag}`,
  documentNamespace: `${releaseUrl}/sbom/${releaseCommit}`,
  creationInfo: {
    created: generatedAt,
    creators: ["Tool: BZFlag-Web release-metadata.mjs", "Organization: Sythos"],
  },
  packages: [
    {
      SPDXID: "SPDXRef-Package-BZFlag-Web",
      name: "BZFlag Web Client release",
      versionInfo: releaseTag.slice(1),
      downloadLocation: releaseUrl,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      filesAnalyzed: false,
      copyrightText: "Copyright (c) 2026 Sythos (https://www.sythos.net) and upstream contributors",
    },
    {
      SPDXID: "SPDXRef-Package-BZFlag-Web-Original",
      name: "BZFlag Web original gateway and browser material",
      versionInfo: releaseTag.slice(1),
      downloadLocation: releaseUrl,
      licenseConcluded: "MIT",
      licenseDeclared: "MIT",
      filesAnalyzed: false,
      copyrightText: "Copyright (c) 2026 Sythos (https://www.sythos.net)",
    },
    {
      SPDXID: "SPDXRef-Package-BZFlag-Upstream-Material",
      name: `BZFlag upstream material ${upstreamRecord.version}`,
      versionInfo: upstreamRecord.version,
      downloadLocation: upstreamRecord.repository,
      licenseConcluded: "LGPL-2.1-only OR MPL-2.0",
      licenseDeclared: "LGPL-2.1-only OR MPL-2.0",
      filesAnalyzed: false,
      copyrightText: "Copyright holders and contributors identified by the BZFlag upstream notices",
      externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: `pkg:github/BZFlag-Dev/bzflag@${upstreamRecord.ref}` }],
    },
  ],
  relationships: [
    { spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: "SPDXRef-Package-BZFlag-Web" },
    { spdxElementId: "SPDXRef-Package-BZFlag-Web", relationshipType: "CONTAINS", relatedSpdxElement: "SPDXRef-Package-BZFlag-Web-Original" },
    { spdxElementId: "SPDXRef-Package-BZFlag-Web", relationshipType: "CONTAINS", relatedSpdxElement: "SPDXRef-Package-BZFlag-Upstream-Material" },
  ],
};
await writeFile(resolve(releaseRoot, "sbom.spdx.json"), `${JSON.stringify(sbom, null, 2)}\n`, "utf8");

const provenance = {
  schemaVersion: 1,
  generatedAt,
  repository,
  releaseTag,
  releaseCommit,
  workflowCommit: process.env.GITHUB_SHA || null,
  workflow: process.env.GITHUB_WORKFLOW || "Release",
  runId: process.env.GITHUB_RUN_ID || null,
  source: {
    repository: `https://github.com/${repository}`,
    ref: releaseTag,
    commit: releaseCommit,
  },
  upstream: upstreamRecord,
  artifacts: [
    `bzflag-web-client-${releaseTag.slice(1)}.zip`,
    `bzflag-web-server-${releaseTag.slice(1)}.zip`,
    `bzflag-web-server-${releaseTag.slice(1)}.tar.gz`,
    `bzflag-web-server-docker-${releaseTag.slice(1)}.tar`,
    `bzflag-web-server-docker-${releaseTag.slice(1)}.tar.gz`,
  ],
};
await writeFile(resolve(releaseRoot, "build-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");

console.log(`Wrote release manifest, SPDX SBOM and build provenance for ${releaseTag} (${releaseCommit}).`);

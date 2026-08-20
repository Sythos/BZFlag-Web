<!--
SPDX-License-Identifier: MIT
Copyright (c) 2026 Sythos (https://www.sythos.net)
-->

# Attribution and provenance

## Web derivation

The BZFlag Web Client gateway, browser-client code, build metadata and other
new original material in this repository are authored and maintained by
Sythos ([https://www.sythos.net](https://www.sythos.net)).  New original files
are MIT-licensed; their headers identify that license with SPDX metadata.

## Upstream BZFlag

The web subset is derived from the BZFlag project:

- project: [BZFlag-Dev/bzflag](https://github.com/BZFlag-Dev/bzflag);
- baseline: BZFlag/BZFS `2.4.31`;
- exact source revision:
  [`59b3ef44fa4538296be8b7f5eeafc2a4e57d0b74`](https://github.com/BZFlag-Dev/bzflag/commit/59b3ef44fa4538296be8b7f5eeafc2a4e57d0b74);
- source line: upstream `2.4`;
- upstream license texts: [`COPYING`](COPYING), [`COPYING.LGPL`](COPYING.LGPL)
  and [`COPYING.MPL`](COPYING.MPL);
- upstream contributor record: [`AUTHORS`](AUTHORS).

Files copied or adapted from upstream retain their original license headers and
applicable LGPL-2.1/MPL-2.0 terms.  If a derived file is modified for the web
client, add only the following co-author indication to its existing header:

```text
Co-author: Sythos (https://www.sythos.net)
```

Do not remove or replace the upstream notice or license.  A copied file that
has not been modified is kept unchanged.

## Third-party material

Third-party libraries, fonts, media, icons, translations and other assets keep
their own notices and licenses.  Release provenance manifests identify the
source, revision, license and local path of each included item.  The MIT license
for new project files does not relicense third-party material.

## Maintainer credit

For visible web-page credits use:

```text
[BZFS 2.4.31] Sythos (https://www.sythos.net)
```

The upstream version in this example must be updated together with the release
metadata when the compatibility baseline changes.

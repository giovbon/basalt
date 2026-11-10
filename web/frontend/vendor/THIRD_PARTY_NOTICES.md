# Third-party notices

The browser libraries below are redistributed unmodified inside this
directory so that NoteDiscovery runs without contacting a CDN. Each one
keeps its own licence text alongside it. NoteDiscovery itself is MIT
licensed; these notices cover the vendored files only.

| Library | Version | Licence | Licence text |
|---------|---------|---------|--------------|
| alpinejs | 3.14.1 | MIT | `alpinejs/LICENSE` |
| dompurify | 3.0.8 | Apache-2.0 | `dompurify/LICENSE` |
| highlight.js | 11.9.0 | BSD-3-Clause | `highlight.js/LICENSE` |
| marked | 12.0.2 | MIT | `marked/LICENSE` |
| mathjax | 3.2.2 | Apache-2.0 | `mathjax/LICENSE` |
| markmap | 0.18.13 | MIT and bundled dependency licences | `markmap/THIRD_PARTY_NOTICES.txt`, `markmap/markmap.js.LEGAL.txt` |
| mermaid | 11.12.2 | MIT | `mermaid/LICENSE` |
| qrcode-generator | 1.4.4 | MIT | `qrcode-generator/LICENSE` |
| tailwindcss | 3.4.17 | MIT | `tailwindcss/LICENSE` |
| vis-network | 9.1.9 | Apache-2.0 | `vis-network/LICENSE` |

DOMPurify is dual-licensed Apache-2.0 OR MPL-2.0 and vis-network is
dual-licensed Apache-2.0 OR MIT; both are taken here under Apache-2.0.

## Bundled npm dependencies

These are compiled into `app.js` by esbuild (see `build-js.sh`) instead of
being copied into this directory, and are listed here for licence tracking.

| Library | Version | Licence |
|---------|---------|---------|
| idb | 8.0.4 | ISC |

ISC License (idb)

Copyright (c) 2016, Jake Archibald <jaffathecake@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

Regenerate this directory with `python scripts/vendor_assets.py`.

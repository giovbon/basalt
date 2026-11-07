#!/usr/bin/env bash
# Rebuild web/frontend/app.js from web/frontend/src/ (esbuild).
#
# Sources are ES modules; the browser gets a single iife bundle, matching the
# classic <script defer src="/static/app.js"> in index.html.
#
# Run after changing anything under web/frontend/src/ and commit the
# regenerated app.js (and app.js.map) together with your change.
set -euo pipefail
cd "$(dirname "$0")/web/frontend"

npx --yes esbuild@0.24.2 src/main.js \
  --bundle \
  --format=iife \
  --target=es2020 \
  --minify \
  --sourcemap \
  --legal-comments=none \
  --banner:js='/* GENERATED FILE - edit web/frontend/src/ and run ./build-js.sh */' \
  --outfile=app.js

mkdir -p vendor/markmap
npx --yes esbuild@0.24.2 src/lib/markmap-renderer.js \
  --bundle \
  --format=esm \
  --target=es2020 \
  --minify \
  --legal-comments=linked \
  --metafile=vendor/markmap/markmap-metafile.json \
  --outfile=vendor/markmap/markmap.js
node scripts/generate-markmap-licenses.js vendor/markmap/markmap-metafile.json
rm vendor/markmap/markmap-metafile.json

echo "OK: web/frontend/app.js ($(wc -c < app.js) bytes, source map $(wc -c < app.js.map) bytes)"

#!/usr/bin/env bash
# Rebuild web/frontend/tailwind.css from the utility classes referenced in
# index.html, partials/, src/ and editor-markdown-continue.js.
#
# Run this after adding or renaming Tailwind classes in those files, then
# commit the regenerated tailwind.css together with your change.
set -euo pipefail
cd "$(dirname "$0")/web/frontend"
npx --yes tailwindcss@3.4.17 \
  -c tailwind.config.js \
  -i tailwind.input.css \
  -o tailwind.css \
  --minify
echo "OK: web/frontend/tailwind.css ($(wc -c < tailwind.css) bytes)"

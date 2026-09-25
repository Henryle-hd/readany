#!/usr/bin/env bash
# ReadAny — local document reader with text-to-speech.
# Usage: ./start.sh            (production, port 4747)
#        PORT=5858 ./start.sh  (other port)
#        ./start.sh --dev      (hot reload)
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"
export NEXT_TELEMETRY_DISABLED=1
PORT="${PORT:-4747}"
HOST="${HOST:-127.0.0.1}"

command -v bun >/dev/null || { echo "bun not found. Install: curl -fsSL https://bun.sh/install | bash"; exit 1; }
mkdir -p docs .cache

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use. Try: PORT=5858 ./start.sh"; exit 1
fi

[ -d node_modules/next ] || bun install

# On-device OCR helper for scanned PDFs / images (macOS Vision, nothing downloaded)
if [ "$(uname)" = "Darwin" ] && [ ! -x .cache/ocr ] && command -v swiftc >/dev/null; then
  echo "• Compiling OCR helper (one time)…"
  swiftc -O lib/ocr.swift -o .cache/ocr 2>/dev/null || echo "  (skipped: scanned pages won't be OCR'd)"
fi
command -v pdftotext >/dev/null || echo "• Tip: brew install poppler  (faster PDF text + scanned-page OCR)"
command -v uvx >/dev/null || command -v markitdown >/dev/null || echo "• Tip: brew install uv  (enables PowerPoint/Excel/EPUB via Microsoft markitdown)"

URL="http://$HOST:$PORT"
banner() {
  echo
  echo "  ┌──────────────────────────────────────────────"
  echo "  │  ReadAny is running →  $URL"
  echo "  │  Docs folder:          $(pwd)/docs"
  echo "  └──────────────────────────────────────────────"
  echo
}

if [ "${1:-}" = "--dev" ]; then
  banner
  exec ./node_modules/.bin/next dev -p "$PORT" -H "$HOST"
fi

if [ ! -f .next/BUILD_ID ] || [ -n "$(find app lib next.config.mjs package.json -newer .next/BUILD_ID -print -quit 2>/dev/null)" ]; then
  echo "• Building (first run takes ~30s)…"
  ./node_modules/.bin/next build >/dev/null 2>.cache/build.log || { cat .cache/build.log; exit 1; }
fi

banner
exec ./node_modules/.bin/next start -p "$PORT" -H "$HOST"

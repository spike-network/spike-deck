#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$ROOT/store"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

capture() {
  local name="$1"
  local url="$2"
  local tmp="$STORE/${name}-2x.png"
  local dest="$STORE/${name}.png"

  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=2 --window-size=1280,800 \
    --screenshot="$tmp" "$url"

  ffmpeg -y -hide_banner -loglevel error \
    -i "$tmp" -vf "scale=1280:800:flags=lanczos" \
    -update 1 -frames:v 1 "$dest"
  rm -f "$tmp"
  echo "wrote $dest"
}

capture screenshot-1280x800 "file://$STORE/screenshot.html"
capture screenshot-mode "file://$STORE/screenshot.html?v=mode"
capture screenshot-profile "file://$STORE/screenshot.html?v=profile"
capture screenshot-providers "file://$STORE/screenshot.html?v=providers"
capture screenshot-options "file://$STORE/screenshot-options.html"

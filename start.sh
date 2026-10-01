#!/usr/bin/env bash
# ==========================================================================
#  PocketOffice launcher (macOS / Linux)
#  Opens PocketOffice in the default browser, or falls back to
#  Chrome/Chromium/Edge. No admin rights needed.
# ==========================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INDEX="$SCRIPT_DIR/index.html"

if [ ! -f "$INDEX" ]; then
  echo "[PocketOffice] ERROR: index.html not found next to start.sh"
  echo "               Make sure you copied the WHOLE PocketOffice folder."
  exit 1
fi

FILE_URL="file://$INDEX"

# --- Try the default browser first (macOS 'open', Linux 'xdg-open') -------
if command -v open >/dev/null 2>&1; then
  open "$FILE_URL" && exit 0
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$FILE_URL" && exit 0
fi

# --- Try common browsers by name -------------------------------------------
for browser in google-chrome chromium-browser chromium microsoft-edge \
               "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
               "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
               "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
  if command -v "$browser" >/dev/null 2>&1; then
    "$browser" "$FILE_URL" && exit 0
  elif [ -x "$browser" ]; then
    "$browser" "$FILE_URL" && exit 0
  fi
done

# --- Last resort -----------------------------------------------------------
echo "[PocketOffice] Could not find a browser to open PocketOffice."
echo ""
echo "  To run PocketOffice manually:"
echo "    1. Open Chrome, Edge, or Firefox."
echo "    2. Press Ctrl+O (or Cmd+O on macOS) and open:"
echo "       $INDEX"
echo "    3. Or paste this address into the browser's address bar:"
echo "       $FILE_URL"
exit 1
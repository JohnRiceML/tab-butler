#!/usr/bin/env bash
# Registers the Tab Butler native messaging host so the extension can list and
# kill localhost dev servers.
#
# Usage:  ./install.sh <extension-id>
# Find <extension-id> at chrome://extensions (Developer mode) on the Tab Butler card.
set -euo pipefail

EXT_ID="${1:-}"
if [ -z "$EXT_ID" ]; then
  echo "Usage: ./install.sh <extension-id>"
  echo "Get the id from chrome://extensions (Developer mode) → the Tab Butler card."
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="com.tab_butler.host"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "node not found on PATH — install Node first."; exit 1; fi

# Wrapper bakes in the absolute node path. Chrome launches native hosts with a
# minimal PATH, so an nvm/homebrew node would otherwise not be found.
cat > "$DIR/run-host.sh" <<SH
#!/bin/bash
exec "$NODE" "$DIR/tabbutler-host.mjs"
SH
chmod +x "$DIR/run-host.sh" "$DIR/tabbutler-host.mjs"

MANIFEST=$(cat <<JSON
{
  "name": "$NAME",
  "description": "Tab Butler localhost helper (list & kill dev servers)",
  "path": "$DIR/run-host.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
)

installed=0
for d in \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"; do
  if [ -d "$(dirname "$d")" ]; then
    mkdir -p "$d"
    printf '%s\n' "$MANIFEST" > "$d/$NAME.json"
    echo "installed → $d/$NAME.json"
    installed=1
  fi
done

if [ "$installed" = 1 ]; then
  echo "Done. Fully quit & reopen the browser, then reload the extension."
else
  echo "No supported browser profile dirs found under ~/Library/Application Support."
fi

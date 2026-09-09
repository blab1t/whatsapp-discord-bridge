#!/usr/bin/env bash
# Install dependencies and start the bridge under pm2 on the Pi.
#
# Deliberately conservative about a shared machine:
#   - the SYSTEM node is never touched. If it is older than 20, Node 20 is
#     installed under ~/.local/node20 and used for this app alone, via pm2's
#     --interpreter. Other pm2 apps keep running on whatever node they use now,
#     and their compiled native modules keep working.
#   - only the pm2 process named below is ever started or restarted. No
#     `pm2 kill`, no `pm2 delete all`, no `pm2 restart all`.
#   - nothing is installed with sudo.
set -euo pipefail

APP_NAME="whatsapp-bridge"
NODE_MIN=20
LOCAL_NODE="$HOME/.local/node20"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
echo "project: $ROOT"

# --- pick a Node 20+ without disturbing the system one ---------------------

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

install_local_node() {
  case "$(uname -m)" in
    aarch64|arm64) arch=arm64 ;;
    armv7l|armv6l) arch=armv7l ;;
    x86_64|amd64)  arch=x64 ;;
    *) echo "ERROR: unsupported CPU $(uname -m)."; exit 1 ;;
  esac

  echo "installing Node 20 ($arch) into $LOCAL_NODE (system node untouched)..."
  local file
  file="$(curl -fsSL https://nodejs.org/dist/latest-v20.x/ \
          | grep -o "node-v20\.[0-9.]*-linux-$arch\.tar\.xz" | head -1)"
  [ -n "$file" ] || { echo "ERROR: could not find a Node 20 build for $arch."; exit 1; }

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  curl -fSL --progress-bar "https://nodejs.org/dist/latest-v20.x/$file" -o "$tmp/node.tar.xz"
  mkdir -p "$LOCAL_NODE"
  tar xJf "$tmp/node.tar.xz" -C "$LOCAL_NODE" --strip-components=1
  echo "installed $("$LOCAL_NODE/bin/node" -v)"
}

if command -v node >/dev/null 2>&1 && [ "$(node_major "$(command -v node)")" -ge "$NODE_MIN" ]; then
  NODE_BIN="$(command -v node)"
  echo "using system node $("$NODE_BIN" -v)"
else
  if command -v node >/dev/null 2>&1; then
    echo "system node is $(node -v) — too old, and it is left exactly as it is."
  fi
  if [ ! -x "$LOCAL_NODE/bin/node" ] || [ "$(node_major "$LOCAL_NODE/bin/node")" -lt "$NODE_MIN" ]; then
    install_local_node
  fi
  NODE_BIN="$LOCAL_NODE/bin/node"
  # Only this script's own PATH. Nothing outside it sees this.
  export PATH="$LOCAL_NODE/bin:$PATH"
  echo "using $("$NODE_BIN" -v) from $LOCAL_NODE for this app only"
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 not found, installing it for the current user..."
  npm install -g pm2
fi

# --- dependencies ----------------------------------------------------------

echo
echo "installing dependencies (better-sqlite3 may compile from source; this can take a few minutes)..."
if ! npm install --omit=dev; then
  echo
  echo "ERROR: npm install failed. On a fresh Pi this is usually missing build tools:"
  echo "  sudo apt update && sudo apt install -y build-essential python3"
  exit 1
fi

# ffmpeg-static has no binary for some ARM builds; convert.js falls back to a
# system ffmpeg, so make sure one of the two exists.
if ! "$NODE_BIN" -e 'process.exit(require("ffmpeg-static") ? 0 : 1)' 2>/dev/null; then
  if ! command -v ffmpeg >/dev/null 2>&1; then
    echo
    echo "NOTE: no bundled ffmpeg for this platform and none on PATH."
    echo "      GIF and sticker conversion will be skipped until you run:"
    echo "        sudo apt install -y ffmpeg"
  fi
fi

# --- seed the database -----------------------------------------------------

# A fresh install ships seed.sql (the chat <-> channel mappings) rather than a
# binary database. Without it the bridge would re-create every Discord channel.
if [ -f data/seed.sql ] && [ ! -f data/bot.db ]; then
  echo
  echo "creating database and seeding chat mappings..."
  "$NODE_BIN" --input-type=module -e 'import "./src/db.js";'   # creates the schema
  "$NODE_BIN" -e '
    const Database = require("better-sqlite3");
    const fs = require("fs");
    const db = new Database("data/bot.db");
    db.exec(fs.readFileSync("data/seed.sql", "utf8"));
    console.log("  chats seeded:", db.prepare("SELECT COUNT(*) n FROM chats").get().n);
  '
fi

# --- sanity checks ---------------------------------------------------------

[ -f .env ] || { echo "ERROR: .env is missing."; exit 1; }
if [ -d data/auth ]; then
  echo "WhatsApp session present ($(ls data/auth | wc -l) key files) — no QR scan needed."
else
  echo "NOTE: no data/auth — you will need to scan a QR on first start."
fi

# --- start under pm2 -------------------------------------------------------

echo
echo "pm2 apps before:"
pm2 list

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  echo "restarting existing pm2 app '$APP_NAME' (only this one)..."
  pm2 restart "$APP_NAME" --update-env
else
  echo "starting '$APP_NAME' under pm2..."
  # --interpreter pins THIS app to the Node we resolved above, so other pm2
  # apps are unaffected by which node they run under.
  # --cwd is not optional: the bridge resolves data/ relative to the working
  # directory, and a resurrect with the wrong cwd would build an empty database
  # and re-create every Discord channel.
  pm2 start src/index.js \
    --name "$APP_NAME" \
    --interpreter "$NODE_BIN" \
    --cwd "$ROOT" \
    --time
fi

# Persists the whole current list, including your other apps. It adds, never removes.
pm2 save
echo
pm2 list
echo
echo "Done. Follow the log with:  pm2 logs $APP_NAME"
echo "To survive a reboot (once, needs sudo):  pm2 startup   # then run the line it prints"

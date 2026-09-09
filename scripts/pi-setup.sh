#!/usr/bin/env bash
# Install dependencies and start the bridge under pm2 on the Pi.
#
# Only ever touches the pm2 process named below. It never runs
# `pm2 kill`, `pm2 delete all` or `pm2 restart all`, so anything else you have
# running under pm2 is left alone.
set -euo pipefail

APP_NAME="whatsapp-bridge"
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
echo "project: $ROOT"

# --- prerequisites ---------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is not installed. Install Node 20+ first:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
echo "node: $(node -v)  npm: $(npm -v)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERROR: Node 20+ required, found $(node -v)."
  exit 1
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 not found, installing globally..."
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
if ! node -e 'process.exit(require("ffmpeg-static") ? 0 : 1)' 2>/dev/null; then
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
  node --input-type=module -e 'import "./src/db.js";'   # creates the schema
  node -e '
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
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  echo "restarting existing pm2 app '$APP_NAME'..."
  pm2 restart "$APP_NAME" --update-env
else
  echo "starting '$APP_NAME' under pm2..."
  # --cwd is not optional: the bridge resolves data/ relative to the working
  # directory, and a resurrect with the wrong cwd would build an empty database
  # and re-create every Discord channel.
  pm2 start src/index.js --name "$APP_NAME" --cwd "$ROOT" --time
fi

pm2 save
echo
pm2 list
echo
echo "Done. Follow the log with:  pm2 logs $APP_NAME"
echo "To survive a reboot (once, needs sudo):  pm2 startup   # then run the line it prints"

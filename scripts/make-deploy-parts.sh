#!/usr/bin/env bash
# Build the Pi deployment payload and split it into paste-sized parts.
#
# A Linux tty drops input lines longer than 4096 bytes, which disconnects some
# browser shells, so every generated line stays well under that. Each part
# writes to its own /tmp file with `>` on the first line, so re-pasting a part
# is harmless — no appending twice, no corruption.
set -euo pipefail

LINE_CHARS=${LINE_CHARS:-3000}      # base64 per line; the wrapper adds ~30 more
LINES_PER_PART=${LINES_PER_PART:-8} # ~24 KB per paste
SKIP_AUTH=${SKIP_AUTH:-0}           # 1 = omit WhatsApp session keys (halves the
                                    #     payload; costs one QR scan on the Pi)
SEED_ONLY=${SEED_ONLY:-0}           # 1 = ship data/seed.sql (a few KB of chat
                                    #     mappings) instead of the whole database
OUT="deploy"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- stage: source, config, database snapshot, WhatsApp session -------------

mkdir -p "$WORK/stage/data"
cp -r src scripts package.json .env "$WORK/stage/"
if [ "$SKIP_AUTH" = "1" ]; then
  echo "omitting WhatsApp session keys - the Pi will need one QR scan"
elif [ -d data/auth ]; then
  cp -r data/auth "$WORK/stage/data/auth"
fi

if [ "$SEED_ONLY" = "1" ]; then
  cp data/seed.sql "$WORK/stage/data/seed.sql"
  echo "shipping seed.sql instead of the database"
else
  # VACUUM INTO is atomic, so the bridge can stay running while this snapshots.
  node -e '
    const Database = require("better-sqlite3");
    const out = process.argv[1].split("\\").join("/") + "/stage/data/bot.db";
    require("fs").rmSync(out, { force: true });
    new Database("data/bot.db").exec(`VACUUM INTO '"'"'${out}'"'"'`);
  ' "$WORK"
fi

( cd "$WORK/stage" && tar czf "$WORK/payload.tgz" --force-local --owner=0 --group=0 . )
base64 -w0 "$WORK/payload.tgz" > "$WORK/payload.b64"

SHA="$(sha256sum "$WORK/payload.tgz" | cut -d' ' -f1)"
TOTAL="$(wc -c < "$WORK/payload.b64" | tr -d ' ')"

# --- split into parts ------------------------------------------------------

rm -rf "$OUT/parts"
mkdir -p "$OUT/parts"
split -b "$LINE_CHARS" -d -a 4 "$WORK/payload.b64" "$WORK/seg"

part=0
n=0
for seg in "$WORK"/seg*; do
  if [ $(( n % LINES_PER_PART )) -eq 0 ]; then
    part=$(( part + 1 ))
    file="$(printf '%s/parts/part%02d.txt' "$OUT" "$part")"
    redirect=">"
  else
    redirect=">>"
  fi
  { printf "echo -n '"; cat "$seg"; printf "' %s /tmp/wb.p%02d\n" "$redirect" "$part"; } >> "$file"
  n=$(( n + 1 ))
done

# --- the final assemble/verify/install line --------------------------------

{
  printf 'cat /tmp/wb.p[0-9][0-9] | base64 -d > /tmp/wb.tgz && echo "%s  /tmp/wb.tgz" | sha256sum -c - && mkdir -p ~/whatsapp-bridge && tar xzf /tmp/wb.tgz -C ~/whatsapp-bridge && rm -f /tmp/wb.p[0-9][0-9] /tmp/wb.tgz && bash ~/whatsapp-bridge/scripts/pi-setup.sh\n' "$SHA"
} > "$OUT/parts/part99-install.txt"

printf 'rm -f /tmp/wb.p[0-9][0-9] /tmp/wb.tgz && echo cleared\n' > "$OUT/parts/part00-reset.txt"
printf 'wc -c /tmp/wb.p[0-9][0-9] | tail -1\n' > "$OUT/parts/check-size.txt"

echo "payload: $(wc -c < "$WORK/payload.tgz" | tr -d ' ') bytes, $TOTAL base64 chars"
echo "sha256:  $SHA"
echo "parts:   $part  (plus reset, size check and install)"
echo "longest line: $(awk '{ if (length > m) m = length } END { print m }' "$OUT"/parts/*.txt) chars"
echo "expected total after all parts: $TOTAL"

# WhatsApp ↔ Discord Bridge

Read and write your WhatsApp messages from Discord. Every chat gets its own
Discord channel; messages, media, replies, edits, deletes and reactions flow
both ways, with Discord and WhatsApp formatting translated between them. You
can also schedule messages to send later.

## Setup

### 1. Discord bot

1. https://discord.com/developers/applications → **New Application**.
2. **Bot** tab → **Reset Token**, copy it into `.env` as `DISCORD_TOKEN`.
3. Same tab, enable **Message Content Intent** (the bridge cannot read what you
   type without it) and **Server Members Intent** (needed for the join
   allowlist). Login fails outright if either is missing.
4. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`,
   permissions **Administrator** (it creates channels, categories and
   webhooks). Open the generated URL and invite it to a **private server that
   only you are in**.
5. Copy that server's id (right-click the server with Developer Mode on) into
   `DISCORD_GUILD_ID`.

### 2. Configure

```bash
cp .env.example .env   # then fill it in
npm install
```

Set `TZ` to your timezone — it is what `/schedule` uses to read times.

### 3. Run

```bash
npm start
```

A QR code prints in the terminal and posts to the `#wa-control` channel. Scan
it in WhatsApp → **Settings → Linked devices → Link a device**. Channels start
appearing as messages arrive.

## Using it

Type in a chat's channel to send to WhatsApp. Delivery is silent; a ❌ plus the
error appears only when a send fails. Reply to a message to quote it, react to
mirror the reaction, edit or delete to do the same on WhatsApp.

| Command | What it does |
|---|---|
| `/schedule <when> <text>` | Send later. `in 2h`, `tomorrow 09:00`, `2026-09-08 14:30`, `18:30` |
| `/scheduled` | Pending messages for this chat |
| `/cancel <id>` | Cancel one |
| `/status` | Connection, chat count, timezone |
| `/qr` | New login QR |
| `/chat <who>` | Search contacts and groups with autocomplete, and open that chat |
| `/sync` | Refresh the contact and group directory |
| `/archive` | Move this channel to the Archive category |
| `/delete confirm:True` | Delete this channel and stop relaying it |
| `/unbridge` | Stop relaying this channel |

Channels idle for 30 days move to an `Archive` category and come back
automatically on the next message — this keeps you under Discord's 500-channel
limit without losing history.

## Finding people

`/chat` searches your WhatsApp contacts and groups as you type and opens the
channel for whoever you pick — creating it if that chat has never messaged you.
Already-bridged chats sort to the top. Pasting a full phone number works for
anyone not in your contacts.

The directory fills from four places, refreshed on every connect:

- your **contacts**, delivered by WhatsApp's history sync (this is the only
  route that carries names — `SYNC_HISTORY=false` disables it and leaves you
  searching numbers only)
- your **groups**
- everyone you **share a group with**, searchable by number immediately and by
  name once they message you
- anyone who **messages you**

`/sync` refreshes it on demand without a restart.

Phone-number searches match **people only**. Group ids look like
`120363<digits>@g.us`, so matching numbers against groups too let a group
swallow a person's number and — because bridged chats sort first — outrank that
person permanently. If an older run left a channel with the wrong name:

```bash
node scripts/fix-chat-names.mjs          # dry run
node scripts/fix-chat-names.mjs --apply
```

## One person, one channel

WhatsApp addresses people two ways: their phone jid (`4915…@s.whatsapp.net`)
and a LID (`1890…@lid`), a hidden id used where the number is not exposed. They
are the same person, so treating them as separate chats produces two Discord
channels for one contact — one filling with their incoming messages, another
created by `/chat` from your address book.

The bridge keys every chat by the phone number. It learns each LID from message
keys (`senderPn` / `participantPn`), and on connect resolves any still-unknown
LID by asking WhatsApp which LID each of your contacts has. Mappings are cached
in the database. When a LID chat and a phone-number chat turn out to be the same
person, the phone-number channel wins and the other is unbridged — delete it
with `/delete confirm:True`.

## Media conversion

Handled automatically, because the two apps disagree about what these are:

| You send | What actually goes across |
|---|---|
| Discord GIF attachment | MP4 with `gifPlayback` — a WhatsApp "GIF" is never a real GIF |
| Tenor / Giphy link | Resolved to the real media and sent as a playing GIF |
| Discord sticker | Converted to a 512×512 WebP sticker (Lottie ones send as `[sticker: name]`) |
| A message of only custom emoji | Sent as sticker images, since `:name:` means nothing on WhatsApp |
| WhatsApp GIF | Converted back to a real looping GIF for Discord when small enough |
| WhatsApp sticker | Sent as WebP, which Discord renders natively |
| Voice note | Relayed both ways as a proper voice message |

Transcoding uses a bundled ffmpeg (`ffmpeg-static`, arm64 included). If a
conversion fails the message still goes through, just in a plainer form.

## Server lockdown

- Every channel the bridge creates denies `@everyone` view access, and existing
  channels are locked on startup. Administrators bypass channel overwrites, so
  the server stays readable to admins only.
- Anyone who joins and is not the bot, the server owner, or listed in
  `ALLOWED_USER_IDS` is banned immediately, with a note in `#wa-control`. Set
  `AUTO_BAN=false` to turn this off.

**Server profile mirroring is mostly not possible, and that is a Discord
limit, not a missing feature.** No bot can set another user's per-server
avatar — there is no API for it, it is a Nitro client feature. And Discord
refuses to let any bot rename the **server owner**, whatever permissions it
holds. So if you own the server, neither half can apply to you; the bridge says
so once in `#wa-control` and moves on. For a non-owner account on the
allowlist, the nickname is set to your WhatsApp name on every connect.

To change the bot's own avatar:

```bash
node scripts/set-bot-avatar.mjs path/to/logo.png
```

## Formatting

Converted automatically in both directions. The important one: `*x*` is
**bold** in WhatsApp but *italic* in Discord, so a naive relay inverts every
message. This one does not.

| Discord | WhatsApp |
|---|---|
| `**bold**` | `*bold*` |
| `*italic*`, `_italic_` | `_italic_` |
| `~~strike~~` | `~strike~` |
| `__underline__` | `_underline_` (WhatsApp has no underline) |
| `# Heading` | `*Heading*` |
| `||spoiler||` | plain text |
| `` `code` ``, code blocks, `> quotes`, lists | unchanged |

## Running on a Raspberry Pi

```bash
docker compose up        # first run, so you can scan the QR
docker compose up -d     # after that
```

`./data` holds the WhatsApp session and the database. Copy that folder plus
`.env` to the Pi and it reconnects without re-pairing.

## Limits and risks

- **Baileys is unofficial.** WhatsApp can ban the number. Low risk at normal
  message rates, not zero.
- Everything you receive is stored on Discord's servers. Keep the server
  private.
- Attachments over `MAX_UPLOAD_MB` (10 by default, Discord's limit for
  unboosted servers) post a notice instead of the file.
- No calls, statuses, or history from before the bridge started.
- Only one copy may run per WhatsApp session. A second one causes both to be
  disconnected repeatedly; the bridge detects this and stops rather than
  fighting, telling you in `#wa-control`.

## Tests

```bash
npm test
```

Covers the formatting conversion, the `/schedule` time parser, the contact
search, and real ffmpeg transcodes — the places where a silent bug would
corrupt or drop real messages.

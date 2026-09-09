# WhatsApp ↔ Discord Bridge — Design

Date: 2026-09-06

## Goal

Replace day-to-day use of the WhatsApp app with Discord. Every WhatsApp
message the user receives appears in Discord; anything the user types in
Discord is delivered to WhatsApp. Formatting is translated in both
directions. Messages can be scheduled for future delivery.

Success criteria: the user can go a full day without opening WhatsApp and
miss nothing — no lost messages, no lost media, no mangled formatting.

## Constraints

- Personal WhatsApp account, all existing chats. This rules out the official
  WhatsApp Business Cloud API (business numbers only, no access to personal
  chat history, 24-hour reply windows).
- Must run on a Raspberry Pi (arm64) eventually. Development and testing
  happen on a Windows laptop first. No headless Chromium — too heavy for a Pi
  and a large dependency to build on ARM.
- Single user, single WhatsApp account, single private Discord server.
- Plain ESM JavaScript, Node 20+. No TypeScript, no bundler, no build step.

## Known Risks

1. **Account ban.** Baileys is an unofficial reimplementation of the WhatsApp
   multi-device protocol. WhatsApp may ban the number. Risk is low at normal
   human message rates but is not zero. The user has accepted this.
2. **Protocol drift.** WhatsApp changes its protocol; Baileys follows. Pin the
   dependency version and expect occasional upgrades.
3. **Privacy.** Every received WhatsApp message becomes a Discord message
   stored on Discord's servers. The Discord server MUST be private to the
   user. The setup docs state this explicitly.

## Architecture

```
WhatsApp (Baileys socket)          Discord (discord.js gateway)
        |                                      |
   whatsapp.js  --normalized events-->  bridge.js  <--events--  discord.js
        |                                 |    |                     |
        +<------- send() ----------------+    +----- webhook send ---+
                                          |
                          format.js  media.js  db.js  schedule.js
```

One process. Every module has one job and can be read on its own.

### Modules (`src/`)

| File | Responsibility |
|---|---|
| `config.js` | Load and validate env vars at boot. Fail fast with a clear message on a missing token. |
| `db.js` | SQLite schema and all queries. The only module that touches the database. |
| `whatsapp.js` | Baileys socket lifecycle: QR login, credential persistence, reconnect with backoff. Emits normalized events. Exposes `send`, `edit`, `delete`, `react`. |
| `discord.js` | Discord client, channel and category creation, webhook cache, archiver. Exposes `postAs(chat, sender, content, files)`. |
| `format.js` | Pure functions `discordToWhatsApp(text)` and `whatsAppToDiscord(text)`. No I/O. |
| `media.js` | Download WhatsApp media to a buffer, upload to Discord, and the reverse. Size guards. |
| `bridge.js` | Both relay directions, ID mapping, loop prevention. |
| `schedule.js` | Parse a "when" string; tick every 30s over due rows and send them. |
| `commands.js` | Slash command definitions, registration, and handlers. |
| `index.js` | Wire the modules together, start, handle shutdown. |

Each file stays under ~300 lines. `format.js` and `schedule.js` are pure
enough to unit test without mocks; they are where the tests live.

### Data model (SQLite, `data/bot.db`)

```sql
CREATE TABLE chats (
  wa_jid       TEXT PRIMARY KEY,   -- 4915...@s.whatsapp.net or ...@g.us
  channel_id   TEXT UNIQUE,        -- Discord channel snowflake
  webhook_id   TEXT,
  webhook_token TEXT,
  name         TEXT,               -- contact or group name at creation
  is_group     INTEGER NOT NULL DEFAULT 0,
  archived     INTEGER NOT NULL DEFAULT 0,
  last_activity INTEGER NOT NULL   -- unix seconds
);

CREATE TABLE messages (
  wa_id       TEXT,                -- WhatsApp message key.id
  wa_jid      TEXT NOT NULL,
  discord_id  TEXT,                -- Discord message snowflake
  from_me     INTEGER NOT NULL,    -- 1 if it originated in Discord
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (wa_id, wa_jid)
);
CREATE INDEX idx_messages_discord ON messages(discord_id);

CREATE TABLE scheduled (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_jid     TEXT NOT NULL,
  channel_id TEXT NOT NULL,        -- where to report success/failure
  body       TEXT NOT NULL,        -- stored in WhatsApp formatting
  send_at    INTEGER NOT NULL,     -- unix seconds
  created_by TEXT NOT NULL,        -- Discord user id
  sent_at    INTEGER,              -- NULL until delivered
  error      TEXT
);
CREATE INDEX idx_scheduled_due ON scheduled(send_at) WHERE sent_at IS NULL;
```

Rows in `messages` older than 90 days are pruned at startup. Reply, edit,
delete, and reaction mirroring all resolve through this table; a message
older than the retention window simply loses those extras, which is
acceptable.

## Channel Mapping

- Each WhatsApp chat gets one Discord text channel, created on first message
  in either direction.
- Channel name: the contact or group name, slugified to Discord's rules
  (lowercase, `-` separated, ≤100 chars), with a numeric suffix on collision.
  The channel topic holds the raw JID and the real display name.
- Channels live in categories named `WhatsApp 1`, `WhatsApp 2`, … A new
  category is created when the current one reaches Discord's 50-channel
  limit.
- A `#wa-control` channel holds login QR codes, connection status, and errors.
- **Archiving:** a nightly job moves any channel with no activity for 30 days
  into an `Archive N` category and sets `archived = 1`. A new message moves it
  back and clears the flag. This keeps the server under Discord's 500-channel
  cap without deleting history.

## Message Flow

### WhatsApp → Discord

1. Baileys emits `messages.upsert`.
2. Ignore status broadcasts and protocol messages.
3. Find or create the chat's channel and webhook.
4. Convert body text with `whatsAppToDiscord`.
5. Download media if present; attach it if under the Discord upload limit,
   otherwise post a `[media too large: <type>, <size>]` notice.
6. If the message quotes another, resolve the quoted WhatsApp ID to a Discord
   message ID via `messages` and post as a Discord reply; on a miss, prefix a
   blockquote of the quoted text.
7. Post through the chat's **webhook**, overriding username and avatar with
   the sender's WhatsApp push name and profile picture. In group chats this
   makes each participant visually distinct.
8. Record the ID pair.

### Discord → WhatsApp

1. `messageCreate` in a channel present in `chats`. Ignore bots and webhooks
   (this is what prevents an echo loop; the bot's own relayed posts come from
   its webhook).
2. Convert with `discordToWhatsApp`.
3. Upload attachments to WhatsApp with the right message type per MIME
   (image / video / audio as a voice note when it is `audio/ogg` /
   document otherwise).
4. If it is a Discord reply, look up the target's WhatsApp ID and quote it.
5. Send. React ✅ on success. On failure react ❌ and post the error in the
   channel — a silent failure is the one unacceptable outcome here.
6. Record the ID pair.

### Reactions, edits, deletes

All three are mirrored in both directions by looking the counterpart ID up in
`messages`. If no mapping exists, the event is dropped silently — it refers to
a message that predates the bridge or has been pruned.

## Formatting Conversion

`format.js` exports two pure functions. Both work the same way: protect the
spans that must not be rewritten, transform the rest, restore.

1. Tokenize fenced code blocks and inline code into placeholders.
2. Tokenize URLs (so `*` and `_` inside a link are not treated as markup).
3. Apply the substitution table.
4. Restore placeholders.

| Discord | WhatsApp | Notes |
|---|---|---|
| `**bold**` | `*bold*` | |
| `*italic*`, `_italic_` | `_italic_` | Discord's `*` is italic, WhatsApp's is bold — the most common thing to get wrong. |
| `***bold italic***` | `*_bold italic_*` | |
| `~~strike~~` | `~strike~` | |
| `__underline__` | `_underline_` | WhatsApp has no underline. Italic is the closest. |
| `` `code` ``, ```` ```block``` ```` | identical | Passed through untouched. |
| `# H1` … `### H3` | `*Heading*` | WhatsApp has no headings. |
| `> quote` | `> quote` | WhatsApp supports blockquotes. |
| `- item`, `1. item` | identical | WhatsApp supports both list styles. |
| `\|\|spoiler\|\|` | `spoiler` | Markers stripped; the text still goes through. |
| `<@123456>` | `@<phone>` with a mention entity | Resolved via the group participant list. Unresolvable IDs become the plain display name. |
| `<#123>`, `<@&123>` | `#name`, `@role` | Plain text. |
| `<:name:123>` | `:name:` | Custom Discord emoji have no WhatsApp equivalent. Unicode emoji pass through unchanged. |

The reverse direction inverts the table. WhatsApp's `_x_` maps to Discord's
`*x*` and WhatsApp's `*x*` to `**x**`; getting this wrong in either direction
is the failure mode the round-trip tests exist to catch.

## Scheduled Messages

`/schedule <when> <text>` in a bridged channel. `<when>` accepts:

- Relative: `in 30m`, `in 2h`, `in 3d`
- Named: `tomorrow 09:00`, `today 18:30`
- Absolute: `2026-09-08 14:30`

Parsed against the timezone in `TZ` (env, defaults to the host's). Parsing is
hand-rolled with regexes over these three shapes — small enough not to justify
a date-parsing dependency. An unparseable string returns an error listing the
accepted forms rather than guessing.

`schedule.js` ticks every 30 seconds, selects rows where
`send_at <= now AND sent_at IS NULL`, sends each, then stamps `sent_at` or
`error`. Because state lives in SQLite, a restart loses nothing; anything that
came due while the process was down is sent on the next tick, with a note in
the channel that it went out late.

Supporting commands: `/scheduled` lists pending messages for the current
channel, `/cancel <id>` deletes one.

## Other Commands

| Command | Effect |
|---|---|
| `/status` | WhatsApp connection state, uptime, bridged-chat count, pending scheduled count. |
| `/qr` | Post a fresh login QR to `#wa-control`. |
| `/bridge <query>` | Force-create a channel for a chat that has not messaged yet, found by name or number. |
| `/unbridge` | Stop relaying this channel. The channel and history stay. |

## Error Handling

- **Connection drop:** reconnect with exponential backoff (1s → 60s cap).
  Status changes post to `#wa-control`.
- **Logged out** (session invalidated on the phone): clear stored credentials,
  post a fresh QR to `#wa-control`, and keep retrying. This is the one failure
  that needs the user's attention, so it is loud.
- **Send failure:** ❌ reaction plus the error text in the channel.
- **Oversized media:** an explicit notice naming type and size. Never a silent
  drop.
- **Unhandled rejections:** logged, never fatal. The bridge stays up.

## Testing

`node --test`, no framework.

- `test/format.test.js` — every row of the conversion table, both directions;
  round-trip stability; markup inside code spans and URLs left untouched;
  the Discord-`*`-is-italic / WhatsApp-`*`-is-bold inversion specifically.
- `test/schedule.test.js` — all three `<when>` shapes, rejection of garbage,
  correct selection of due rows.

No tests run against live WhatsApp or Discord. The relay logic is verified by
hand during setup.

## Deployment

Development: `npm install && npm start` on the laptop. Scan the QR printed to
the terminal.

Production: a `Dockerfile` on `node:20-bookworm-slim` (arm64 compatible) and a
`docker-compose.yml` mounting `./data` for `auth/` (Baileys credentials) and
`bot.db`. Moving from laptop to Pi means copying `data/` and `.env`; no
re-pairing needed.

Config via `.env`: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`,
`TZ`, `ARCHIVE_AFTER_DAYS` (default 30), `LOG_LEVEL`. `.env` and `data/` are
gitignored.

## Out of Scope

- WhatsApp calls, status/stories, and polls.
- Multiple WhatsApp accounts or multiple Discord users.
- Backfilling chat history from before the bridge started.
- A web UI. Discord is the UI.

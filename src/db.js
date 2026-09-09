import Database from 'better-sqlite3';
import { config } from './config.js';

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS chats (
  wa_jid        TEXT PRIMARY KEY,
  channel_id    TEXT UNIQUE,
  webhook_id    TEXT,
  webhook_token TEXT,
  name          TEXT,
  is_group      INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  muted         INTEGER NOT NULL DEFAULT 0,
  last_activity INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  wa_id      TEXT NOT NULL,
  wa_jid     TEXT NOT NULL,
  discord_id TEXT,
  from_me    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (wa_id, wa_jid)
);
CREATE INDEX IF NOT EXISTS idx_messages_discord ON messages(discord_id);

CREATE TABLE IF NOT EXISTS scheduled (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_jid     TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  body       TEXT NOT NULL,
  send_at    INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  sent_at    INTEGER,
  error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled(send_at);

-- The address book WhatsApp syncs to us, so search covers everyone, not just
-- the chats that happen to have messaged since the bridge started.
CREATE TABLE IF NOT EXISTS contacts (
  wa_jid     TEXT PRIMARY KEY,
  name       TEXT,
  is_group   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);

-- WhatsApp LID -> phone jid. Persisted so a restart does not have to re-query
-- every contact to work out who a LID belongs to.
CREATE TABLE IF NOT EXISTS lid_map (
  lid        TEXT PRIMARY KEY,
  wa_jid     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

const now = () => Math.floor(Date.now() / 1000);

// --- chats -----------------------------------------------------------------

export const chats = {
  byJid: db.prepare('SELECT * FROM chats WHERE wa_jid = ?'),
  byChannel: db.prepare('SELECT * FROM chats WHERE channel_id = ?'),

  get(waJid) {
    return this.byJid.get(waJid);
  },
  getByChannel(channelId) {
    return this.byChannel.get(channelId);
  },
  all() {
    return db.prepare('SELECT * FROM chats').all();
  },
  upsert({ waJid, channelId, webhookId, webhookToken, name, isGroup }) {
    db.prepare(
      `INSERT INTO chats (wa_jid, channel_id, webhook_id, webhook_token, name, is_group, last_activity)
       VALUES (@waJid, @channelId, @webhookId, @webhookToken, @name, @isGroup, @ts)
       ON CONFLICT(wa_jid) DO UPDATE SET
         channel_id    = excluded.channel_id,
         webhook_id    = excluded.webhook_id,
         webhook_token = excluded.webhook_token,
         name          = excluded.name,
         archived      = 0,
         last_activity = excluded.last_activity`,
    ).run({ waJid, channelId, webhookId, webhookToken, name, isGroup: isGroup ? 1 : 0, ts: now() });
    return this.get(waJid);
  },
  touch(waJid) {
    db.prepare('UPDATE chats SET last_activity = ?, archived = 0 WHERE wa_jid = ?').run(now(), waJid);
  },
  setArchived(waJid, archived) {
    db.prepare('UPDATE chats SET archived = ? WHERE wa_jid = ?').run(archived ? 1 : 0, waJid);
  },
  remove(waJid) {
    db.prepare('DELETE FROM chats WHERE wa_jid = ?').run(waJid);
  },
  /**
   * Move a chat (and its message history) onto a different jid, keeping the
   * same Discord channel. Used when a chat first seen under a WhatsApp LID is
   * revealed to belong to a real phone number.
   */
  remap(fromJid, toJid) {
    const move = db.transaction(() => {
      db.prepare('UPDATE chats SET wa_jid = ? WHERE wa_jid = ?').run(toJid, fromJid);
      db.prepare('UPDATE messages SET wa_jid = ? WHERE wa_jid = ?').run(toJid, fromJid);
      db.prepare('UPDATE scheduled SET wa_jid = ? WHERE wa_jid = ?').run(toJid, fromJid);
    });
    move();
    return this.get(toJid);
  },
  staleBefore(cutoffSeconds) {
    return db
      .prepare('SELECT * FROM chats WHERE archived = 0 AND last_activity < ?')
      .all(cutoffSeconds);
  },
};

// --- contacts / directory search -------------------------------------------

export const contacts = {
  upsertMany(list) {
    const stmt = db.prepare(
      `INSERT INTO contacts (wa_jid, name, is_group, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(wa_jid) DO UPDATE SET
         -- Never overwrite a real name with a blank one from a later sync.
         name       = COALESCE(NULLIF(excluded.name, ''), contacts.name),
         is_group   = excluded.is_group,
         updated_at = excluded.updated_at`,
    );
    const ts = now();
    const run = db.transaction((rows) => {
      for (const row of rows) {
        if (!row?.waJid) continue;
        stmt.run(row.waJid, row.name || null, row.isGroup ? 1 : 0, ts);
      }
    });
    run(list);
  },
  count() {
    return db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  },
};

export const lidMap = {
  all() {
    return db.prepare('SELECT lid, wa_jid FROM lid_map').all();
  },
  setMany(pairs) {
    const stmt = db.prepare(
      `INSERT INTO lid_map (lid, wa_jid, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(lid) DO UPDATE SET wa_jid = excluded.wa_jid, updated_at = excluded.updated_at`,
    );
    const ts = now();
    db.transaction((rows) => {
      for (const [lid, waJid] of rows) if (lid && waJid) stmt.run(lid, waJid, ts);
    })(pairs);
  },
  /** Phone jids of contacts we have no LID for yet. */
  unmappedNumbers(limit = 500) {
    return db
      .prepare(
        `SELECT c.wa_jid FROM contacts c
          WHERE c.is_group = 0 AND c.wa_jid LIKE '%@s.whatsapp.net'
            AND NOT EXISTS (SELECT 1 FROM lid_map m WHERE m.wa_jid = c.wa_jid)
          LIMIT ?`,
      )
      .all(limit)
      .map((r) => r.wa_jid);
  },
  /** Chats still keyed by a LID, which means a possible duplicate contact. */
  lidChats() {
    return db.prepare("SELECT * FROM chats WHERE wa_jid LIKE '%@lid'").all();
  },
};

/** The part of a jid before the @, i.e. the phone number or group id. */
const LOCAL_PART = "substr(%s.wa_jid, 1, instr(%s.wa_jid, '@') - 1)";

/**
 * Search contacts and bridged chats together. Bridged chats sort first, most
 * recently active first, so the people you actually talk to lead the list.
 * An empty query returns recent chats, which is what you usually want.
 *
 * Digits are matched against PEOPLE only. Matching them against groups too
 * let a group (whose id is 120363<digits>@g.us) swallow a person's phone
 * number — and since bridged rows sort first, that group then outranked the
 * person permanently, making them impossible to reach.
 */
export function searchDirectory(query = '', limit = 25) {
  const trimmed = String(query).trim();
  const q = `%${trimmed}%`;
  const digits = trimmed.replace(/[^\d]/g, '');
  // Only treat the query as a number when that is plainly what it is.
  const asNumber = digits.length >= 4 && /^[\d\s+()-]+$/.test(trimmed);
  const numberPrefix = asNumber ? `%${digits}%` : null;

  const clause = (alias) =>
    `COALESCE(${alias}.name, '') LIKE @q` +
    (numberPrefix
      ? ` OR (${alias}.is_group = 0 AND ${LOCAL_PART.replaceAll('%s', alias)} LIKE @num)`
      : '');

  return db
    .prepare(
      `SELECT wa_jid, name, is_group, channel_id, last_activity FROM (
         SELECT c.wa_jid       AS wa_jid,
                COALESCE(ch.name, c.name) AS name,
                c.is_group     AS is_group,
                ch.channel_id  AS channel_id,
                ch.last_activity AS last_activity
           FROM contacts c
           LEFT JOIN chats ch ON ch.wa_jid = c.wa_jid
          WHERE ${clause('c')}
         UNION
         SELECT ch.wa_jid, ch.name, ch.is_group, ch.channel_id, ch.last_activity
           FROM chats ch
          WHERE ${clause('ch')}
       )
       ORDER BY (channel_id IS NULL), (last_activity IS NULL), last_activity DESC, name COLLATE NOCASE
       LIMIT @limit`,
    )
    .all(numberPrefix ? { q, num: numberPrefix, limit } : { q, limit });
}

/** Look one jid up exactly. Never guesses, unlike searchDirectory. */
export function lookupJid(waJid) {
  return db
    .prepare(
      `SELECT c.wa_jid AS wa_jid,
              COALESCE(ch.name, c.name) AS name,
              c.is_group AS is_group,
              ch.channel_id AS channel_id
         FROM contacts c
         LEFT JOIN chats ch ON ch.wa_jid = c.wa_jid
        WHERE c.wa_jid = ?
        UNION
       SELECT ch.wa_jid, ch.name, ch.is_group, ch.channel_id
         FROM chats ch
        WHERE ch.wa_jid = ?
        LIMIT 1`,
    )
    .get(waJid, waJid);
}

// --- message id mapping ----------------------------------------------------

export const messages = {
  link({ waId, waJid, discordId, fromMe }) {
    if (!waId || !discordId) return;
    db.prepare(
      `INSERT INTO messages (wa_id, wa_jid, discord_id, from_me, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(wa_id, wa_jid) DO UPDATE SET discord_id = excluded.discord_id`,
    ).run(waId, waJid, discordId, fromMe ? 1 : 0, now());
  },
  byWaId(waId, waJid) {
    return db.prepare('SELECT * FROM messages WHERE wa_id = ? AND wa_jid = ?').get(waId, waJid);
  },
  byDiscordId(discordId) {
    return db.prepare('SELECT * FROM messages WHERE discord_id = ?').get(discordId);
  },
  prune(cutoffSeconds) {
    return db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoffSeconds).changes;
  },
};

// --- scheduled messages ----------------------------------------------------

export const scheduled = {
  add({ waJid, channelId, body, sendAt, createdBy }) {
    const info = db
      .prepare(
        `INSERT INTO scheduled (wa_jid, channel_id, body, send_at, created_by)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(waJid, channelId, body, sendAt, createdBy);
    return info.lastInsertRowid;
  },
  due(ts = now()) {
    return db
      .prepare('SELECT * FROM scheduled WHERE sent_at IS NULL AND error IS NULL AND send_at <= ?')
      .all(ts);
  },
  pendingForChannel(channelId) {
    return db
      .prepare(
        'SELECT * FROM scheduled WHERE channel_id = ? AND sent_at IS NULL ORDER BY send_at ASC',
      )
      .all(channelId);
  },
  markSent(id) {
    db.prepare('UPDATE scheduled SET sent_at = ? WHERE id = ?').run(now(), id);
  },
  markFailed(id, error) {
    db.prepare('UPDATE scheduled SET error = ? WHERE id = ?').run(String(error).slice(0, 500), id);
  },
  cancel(id, channelId) {
    return db
      .prepare('DELETE FROM scheduled WHERE id = ? AND channel_id = ? AND sent_at IS NULL')
      .run(id, channelId).changes;
  },
  pendingCount() {
    return db.prepare('SELECT COUNT(*) AS n FROM scheduled WHERE sent_at IS NULL').get().n;
  },
};

export { db, now };

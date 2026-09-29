import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
// Baileys 6.17 turned its default export into an object, so makeWASocket has
// to be imported by name. Importing it as the default silently yields a
// non-callable object.
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import { config } from './config.js';
import { logger } from './logger.js';
import { canonical, normalize, isLid } from './jid.js';
import { lidMap as lidStore } from './db.js';

const PROTOCOL_REVOKE = 0;
const PROTOCOL_EDIT = 14;

/**
 * Baileys socket lifecycle plus a normalized event surface.
 *
 * Events:
 *   qr(dataString)              login QR needs scanning
 *   status(state, detail)       'connecting' | 'open' | 'closed' | 'logged-out'
 *   message(normalized)         inbound (and own outbound) chat message
 *   edit({ waId, jid, text })
 *   revoke({ waId, jid })
 *   reaction({ waId, jid, emoji, fromMe })
 */
export class WhatsApp extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.state = 'connecting';
    this.backoffMs = 1000;
    this.connectedAt = null;
    this.groupNameCache = new Map();
    this.pairNumber = config.pairNumber;
    this.pairingCode = null;
    // WhatsApp LID -> phone jid, learned from message keys as they arrive and
    // persisted, so a restart does not re-learn from scratch.
    this.lidMap = new Map(lidStore.all().map((r) => [r.lid, r.wa_jid]));
  }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      // We render the QR ourselves so it can also go to Discord.
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      // The one and only moment WhatsApp hands over the address book is the
      // initial link, and only with this on. History messages are filtered out
      // in #onUpsert, so this costs a slower first connect and nothing else.
      syncFullHistory: config.syncHistory,
      generateHighQualityLinkPreview: true,
    });

    // Pairing by code beats a QR over a remote shell: nothing to photograph,
    // and no 20-second expiry race.
    if (this.pairNumber && !this.sock.authState.creds.registered) {
      setTimeout(() => this.#requestPairingCode(), 4000);
    }

    this.sock.ev.on('creds.update', saveCreds);
    this.sock.ev.on('connection.update', (u) => this.#onConnectionUpdate(u));
    this.sock.ev.on('messages.upsert', (u) => this.#onUpsert(u));
    this.sock.ev.on('messages.reaction', (rs) => this.#onReactions(rs));

    // Address-book sync. WhatsApp pushes these on link and whenever anything
    // changes, which is what makes /chat able to find someone who has never
    // messaged the bridge.
    this.sock.ev.on('contacts.upsert', (cs) => this.#onContacts(cs));
    this.sock.ev.on('contacts.update', (cs) => this.#onContacts(cs));
    this.sock.ev.on('chats.upsert', (cs) => this.#onContacts(cs));
    this.sock.ev.on('groups.upsert', (gs) => this.#onGroups(gs));
    this.sock.ev.on('messaging-history.set', ({ contacts: cs = [], chats: chs = [] }) => {
      this.#onContacts([...cs, ...chs]);
    });
  }

  async #requestPairingCode() {
    try {
      const code = await this.sock.requestPairingCode(this.pairNumber);
      this.pairingCode = code;
      logger.info(`pairing code for +${this.pairNumber}: ${code}`);
      this.emit('pairing-code', code, this.pairNumber);
    } catch (err) {
      logger.error({ err: err.message }, 'could not get a pairing code');
      this.emit('status', 'closed', `Pairing code request failed: ${err.message}`);
    }
  }

  /**
   * Start a fresh link using a pairing code. Drops the stored credentials, so
   * the reconnect registers from scratch.
   */
  async startPairing(phoneDigits) {
    this.pairNumber = String(phoneDigits).replace(/[^0-9]/g, '');
    this.pairingCode = null;
    try {
      this.sock?.end(new Error('re-pairing'));
    } catch {
      /* the close handler schedules the restart */
    }
    rmSync(config.authDir, { recursive: true, force: true });
    this.directorySynced = false;
    setTimeout(() => {
      this.start().catch((err) => logger.error({ err }, 'pairing restart failed'));
    }, 1000);
  }

  /**
   * Pull the address book explicitly. WhatsApp only pushes contacts during the
   * initial link, so a session that was paired earlier would otherwise have an
   * empty directory forever.
   */
  async syncDirectory() {
    try {
      await this.sock.resyncAppState(['critical_unblock_low', 'regular_high', 'regular_low'], false);
    } catch (err) {
      logger.warn({ err: err.message }, 'app state resync failed');
    }
    await this.#resolveLids();

    try {
      const groups = Object.values((await this.sock.groupFetchAllParticipating()) || {});
      this.#onGroups(groups);

      // Everyone you share a group with becomes searchable by number straight
      // away; their name fills in the first time they message you.
      const people = new Map();
      for (const group of groups) {
        for (const participant of group.participants || []) {
          const jid = participant.id;
          if (jid && jid.endsWith('@s.whatsapp.net') && jid !== this.me) {
            people.set(jid, { waJid: jid, name: '', isGroup: false });
          }
        }
      }
      if (people.size) {
        logger.info(`found ${people.size} people across ${groups.length} groups`);
        this.emit('contacts', [...people.values()]);
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'group fetch failed');
    }
  }

  /**
   * Work out which phone number each LID belongs to.
   *
   * The mapping is only queryable number -> LID, so resolving a LID means
   * asking about the numbers we know and keeping the answers. Only worth doing
   * while some chat is still keyed by an unresolved LID — otherwise it is a
   * large query for nothing.
   */
  async #resolveLids() {
    const unresolved = lidStore
      .lidChats()
      .filter((c) => !this.lidMap.has(normalize(c.wa_jid)));
    if (!unresolved.length) return;

    const numbers = lidStore.unmappedNumbers();
    if (!numbers.length) return;

    const pairs = [];
    // USync takes batches; a few large calls beat hundreds of small ones.
    for (let i = 0; i < numbers.length; i += 100) {
      try {
        const results = (await this.sock.onWhatsApp(...numbers.slice(i, i + 100))) || [];
        for (const r of results) {
          if (r?.lid && r?.jid) pairs.push([normalize(String(r.lid)), normalize(r.jid)]);
        }
      } catch (err) {
        logger.warn({ err: err.message }, 'lid lookup batch failed');
        break;
      }
    }
    if (!pairs.length) return;

    lidStore.setMany(pairs);
    for (const [lid, pn] of pairs) this.lidMap.set(lid, pn);

    const resolved = unresolved.filter((c) => this.lidMap.has(normalize(c.wa_jid)));
    logger.info(
      `learned ${pairs.length} LID mappings; ${resolved.length} of ${unresolved.length} LID chats can now be merged`,
    );
    if (resolved.length) {
      this.emit(
        'lids-resolved',
        resolved.map((c) => ({ lid: normalize(c.wa_jid), jid: this.lidMap.get(normalize(c.wa_jid)) })),
      );
    }
  }

  #onContacts(list) {
    const rows = [];
    for (const c of list || []) {
      const jid = c?.id;
      if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast')) continue;
      rows.push({
        waJid: jid,
        name: c.name || c.subject || c.notify || c.verifiedName || '',
        isGroup: jid.endsWith('@g.us'),
      });
    }
    if (rows.length) this.emit('contacts', rows);
  }

  #onGroups(groups) {
    this.#onContacts((groups || []).map((g) => ({ id: g.id, name: g.subject })));
  }

  #onConnectionUpdate({ connection, lastDisconnect, qr }) {
    if (qr) this.emit('qr', qr);

    if (connection === 'open') {
      this.state = 'open';
      this.connectedAt = Date.now();
      this.backoffMs = 1000;
      this.emit('status', 'open');
      if (!this.directorySynced) {
        this.directorySynced = true;
        this.syncDirectory().catch((err) => logger.warn({ err }, 'directory sync failed'));
      }
      return;
    }

    if (connection !== 'close') return;

    const code = lastDisconnect?.error?.output?.statusCode;
    if (code === DisconnectReason.loggedOut) {
      // The session was invalidated on the phone. Credentials are useless now;
      // clearing them is what lets the next start() produce a fresh QR.
      this.state = 'logged-out';
      rmSync(config.authDir, { recursive: true, force: true });
      this.emit('status', 'logged-out', 'Session ended on the phone. Scan the new QR to reconnect.');
    } else {
      this.state = 'closed';
      this.emit('status', 'closed', lastDisconnect?.error?.message || `code ${code}`);
    }

    const conflict = /conflict|replaced/i.test(lastDisconnect?.error?.message || '');
    if (conflict) {
      this.conflicts = (this.conflicts || 0) + 1;
      if (this.conflicts >= 3) {
        this.state = 'conflict';
        this.emit(
          'status',
          'conflict',
          'Another copy of the bridge is using this WhatsApp session. Stop the other one, then restart. Not reconnecting.',
        );
        return;
      }
    } else {
      this.conflicts = 0;
    }

    const delay = conflict ? 15_000 : this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    setTimeout(() => {
      this.start().catch((err) => logger.error({ err }, 'whatsapp restart failed'));
    }, delay);
  }

  #onUpsert({ messages: msgs, type }) {
    if (type !== 'notify') return; // 'append' is history sync, not new mail
    for (const msg of msgs) {
      try {
        this.#handleMessage(msg);
      } catch (err) {
        logger.error({ err }, 'failed handling whatsapp message');
      }
    }
  }

  #handleMessage(msg) {
    if (!msg.key?.remoteJid || msg.key.remoteJid === 'status@broadcast') return;
    const { jid, alt, senderJid } = canonical(msg.key, this.lidMap);
    if (!jid) return;

    // Unwrap the envelopes WhatsApp uses for edits and view-once media.
    let content = msg.message;
    content = content?.ephemeralMessage?.message ?? content;
    content = content?.viewOnceMessageV2?.message ?? content?.viewOnceMessage?.message ?? content;
    if (!content) return;

    const protocol = content.protocolMessage ?? content.editedMessage?.message?.protocolMessage;
    if (protocol) {
      const targetId = protocol.key?.id;
      if (protocol.type === PROTOCOL_REVOKE && targetId) {
        this.emit('revoke', { waId: targetId, jid });
      } else if (protocol.type === PROTOCOL_EDIT && targetId) {
        const edited = protocol.editedMessage;
        const text = edited?.conversation ?? edited?.extendedTextMessage?.text ?? '';
        this.emit('edit', { waId: targetId, jid, text });
      }
      return;
    }

    const normalized = this.#normalize(msg, content, jid, alt, senderJid);
    if (normalized) this.emit('message', normalized);
  }

  #normalize(msg, content, jid, alt, senderJid) {
    const kinds = [
      ['imageMessage', 'image'],
      ['videoMessage', 'video'],
      ['audioMessage', 'audio'],
      ['documentMessage', 'document'],
      ['stickerMessage', 'sticker'],
      ['documentWithCaptionMessage', 'document'],
    ];

    let mediaType = null;
    let media = null;
    for (const [key, kind] of kinds) {
      if (content[key]) {
        mediaType = kind;
        media = content[key];
        break;
      }
    }
    if (content.documentWithCaptionMessage) {
      media = content.documentWithCaptionMessage.message?.documentMessage ?? media;
    }

    const text =
      content.conversation ??
      content.extendedTextMessage?.text ??
      media?.caption ??
      '';

    const contextInfo = content.extendedTextMessage?.contextInfo ?? media?.contextInfo;
    const quotedId = contextInfo?.stanzaId;
    const quotedText =
      contextInfo?.quotedMessage?.conversation ??
      contextInfo?.quotedMessage?.extendedTextMessage?.text ??
      '';

    const isGroup = jid.endsWith('@g.us');

    // Location, contact cards and polls have no text; describe them rather
    // than dropping the message silently.
    let placeholder = '';
    if (!text && !media) {
      if (content.locationMessage) {
        const l = content.locationMessage;
        placeholder = `📍 Location: https://maps.google.com/?q=${l.degreesLatitude},${l.degreesLongitude}`;
      } else if (content.contactMessage || content.contactsArrayMessage) {
        placeholder = '👤 Contact card (open WhatsApp to view)';
      } else if (content.pollCreationMessage || content.pollCreationMessageV3) {
        const p = content.pollCreationMessage ?? content.pollCreationMessageV3;
        const options = (p.options || []).map((o) => `• ${o.optionName}`).join('\n');
        placeholder = `📊 Poll: ${p.name}\n${options}`;
      } else {
        return null; // reactions, receipts, and other non-content events
      }
    }

    return {
      raw: msg,
      waId: msg.key.id,
      jid,
      // The LID this arrived under, when it differs; lets the bridge fold an
      // existing LID-keyed chat into the phone-number one.
      altJid: alt,
      fromMe: Boolean(msg.key.fromMe),
      senderJid,
      senderName: msg.pushName || senderJid.split('@')[0],
      isGroup,
      text: text || placeholder,
      mediaType,
      media,
      isVoiceNote: Boolean(media?.ptt),
      gifPlayback: Boolean(media?.gifPlayback),
      fileName: media?.fileName,
      mimetype: media?.mimetype,
      fileLength: Number(media?.fileLength || 0),
      quotedId,
      quotedText,
      timestamp: Number(msg.messageTimestamp || 0),
    };
  }

  #onReactions(reactions) {
    for (const r of reactions) {
      const targetId = r.key?.id;
      if (!targetId || !r.key?.remoteJid) continue;
      const { jid } = canonical(r.key, this.lidMap);
      this.emit('reaction', {
        waId: targetId,
        jid,
        emoji: r.reaction?.text || '',
        fromMe: Boolean(r.reaction?.key?.fromMe ?? r.key?.fromMe),
      });
    }
  }

  // --- outbound ------------------------------------------------------------

  #assertReady() {
    if (!this.sock || this.state !== 'open') {
      throw new Error(`WhatsApp is not connected (state: ${this.state})`);
    }
  }

  async send(jid, payload, options = {}) {
    this.#assertReady();
    return this.sock.sendMessage(jid, payload, options);
  }

  async sendText(jid, text, quotedMsg) {
    return this.send(jid, { text }, quotedMsg ? { quoted: quotedMsg } : {});
  }

  async react(jid, waId, emoji, fromMe = false) {
    this.#assertReady();
    return this.sock.sendMessage(jid, {
      react: { text: emoji, key: { remoteJid: jid, id: waId, fromMe } },
    });
  }

  async deleteMessage(jid, waId, fromMe = true) {
    this.#assertReady();
    return this.sock.sendMessage(jid, { delete: { remoteJid: jid, id: waId, fromMe } });
  }

  async editMessage(jid, waId, text, fromMe = true) {
    this.#assertReady();
    return this.sock.sendMessage(jid, { text, edit: { remoteJid: jid, id: waId, fromMe } });
  }

  async downloadMedia(msg) {
    return downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger, reuploadRequest: this.sock.updateMediaMessage },
    );
  }

  /** @returns {Promise<string|null>} the jid if the number is on WhatsApp */
  async exists(phoneDigits) {
    this.#assertReady();
    const [result] = await this.sock.onWhatsApp(`${phoneDigits}@s.whatsapp.net`);
    return result?.exists ? result.jid : null;
  }

  /** Drop the current socket so reconnection emits a fresh QR. */
  requestQr() {
    try {
      this.sock?.end(new Error('QR requested'));
    } catch {
      /* the connection.update handler schedules the restart */
    }
  }

  async profilePicture(jid) {
    try {
      return await this.sock.profilePictureUrl(jid, 'image');
    } catch {
      return null; // no picture, or privacy settings hide it
    }
  }

  async chatName(jid, fallback) {
    if (!jid.endsWith('@g.us')) return fallback;
    if (this.groupNameCache.has(jid)) return this.groupNameCache.get(jid);
    try {
      const meta = await this.sock.groupMetadata(jid);
      this.groupNameCache.set(jid, meta.subject);
      return meta.subject;
    } catch {
      return fallback;
    }
  }

  get me() {
    return this.sock?.user ? jidNormalizedUser(this.sock.user.id) : null;
  }

  /** The name shown on your WhatsApp account, falling back to the number. */
  get displayName() {
    return this.sock?.user?.name || this.sock?.user?.verifiedName || this.me?.split('@')[0] || null;
  }
}

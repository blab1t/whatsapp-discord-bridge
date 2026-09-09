import { config } from './config.js';
import { logger } from './logger.js';
import { chats, messages, contacts } from './db.js';
import { discordToWhatsApp, whatsAppToDiscord, quoteBlock } from './format.js';
import { fromWhatsApp, toWhatsApp } from './media.js';
import { findGifLinks, isOnlyGifLinks, gifLinkToWhatsApp, toSticker, download } from './convert.js';

const DISCORD_MAX_CHARS = 2000;

/** Split on paragraph, then line, then hard boundaries so nothing is lost. */
function chunk(text, size = DISCORD_MAX_CHARS) {
  if (text.length <= size) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const at = cut > size * 0.5 ? cut : size;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\s/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Discord sticker formats. Lottie is vector JSON and has no WhatsApp form. */
const STICKER_FORMAT = { 1: 'png', 2: 'png', 3: 'lottie', 4: 'gif' };

/** A message that is nothing but custom emoji is really a sticker. */
const ONLY_CUSTOM_EMOJI = /^(?:<(a)?:\w+:(\d+)>\s*)+$/;

function customEmojiIn(content) {
  return [...String(content).matchAll(/<(a)?:(\w+):(\d+)>/g)].map(([, animated, name, id]) => ({
    name,
    animated: Boolean(animated),
    url: `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}`,
  }));
}

export class Bridge {
  constructor(wa, discord) {
    this.wa = wa;
    this.discord = discord;
    this.avatars = new Map(); // senderJid -> url, avoids refetching per message
  }

  attach() {
    this.wa.on('message', (msg) => this.#waToDiscord(msg).catch(this.#log('wa->discord')));
    this.wa.on('edit', (e) => this.#waEdit(e).catch(this.#log('wa edit')));
    this.wa.on('revoke', (e) => this.#waRevoke(e).catch(this.#log('wa revoke')));
    this.wa.on('reaction', (e) => this.#waReaction(e).catch(this.#log('wa reaction')));

    const client = this.discord.client;
    client.on('messageCreate', (m) => this.#discordToWa(m).catch(this.#log('discord->wa')));
    client.on('messageUpdate', (_old, m) => this.#discordEdit(m).catch(this.#log('discord edit')));
    client.on('messageDelete', (m) => this.#discordDelete(m).catch(this.#log('discord delete')));
    client.on('messageReactionAdd', (r, u) =>
      this.#discordReaction(r, u).catch(this.#log('discord reaction')),
    );
  }

  #log(where) {
    return (err) => logger.error({ err }, `${where} failed`);
  }

  // --- WhatsApp -> Discord -------------------------------------------------

  async #chatFor(msg) {
    // This person was first seen under a LID. Fold that chat into the phone
    // number now that we know it, so one contact never gets two channels.
    if (msg.altJid) {
      const byLid = chats.get(msg.altJid);
      if (byLid) {
        if (chats.get(msg.jid)) {
          // Both exist already: keep the phone-number channel and stop
          // relaying into the LID one. Its channel stays, use /delete on it.
          chats.remove(msg.altJid);
          logger.warn(
            { lid: msg.altJid, jid: msg.jid },
            'duplicate channel for one contact; keeping the phone-number one',
          );
        } else {
          chats.remap(msg.altJid, msg.jid);
          logger.info({ lid: msg.altJid, jid: msg.jid }, 'merged LID chat into phone number');
        }
      }
    }

    const known = chats.get(msg.jid);
    const fallback = msg.jid.split('@')[0];
    const name =
      known?.name ||
      (msg.isGroup
        ? await this.wa.chatName(msg.jid, fallback)
        : msg.fromMe
          ? fallback
          : msg.senderName || fallback);
    return this.discord.getOrCreateChat({ waJid: msg.jid, name, isGroup: msg.isGroup });
  }

  async #avatarFor(jid) {
    if (this.avatars.has(jid)) return this.avatars.get(jid);
    const url = await this.wa.profilePicture(jid);
    this.avatars.set(jid, url);
    return url;
  }

  async #waToDiscord(msg) {
    // Messages we sent through the bridge come back as fromMe echoes; skip
    // them or every outbound message appears twice.
    if (msg.fromMe && messages.byWaId(msg.waId, msg.jid)) return;

    const chat = await this.#chatFor(msg);
    chats.touch(msg.jid);

    // Everyone who writes to you becomes searchable, whether or not the
    // address book ever synced.
    if (!msg.fromMe) {
      contacts.upsertMany([
        { waJid: msg.jid, name: msg.isGroup ? chat.name : msg.senderName, isGroup: msg.isGroup },
        ...(msg.isGroup ? [{ waJid: msg.senderJid, name: msg.senderName, isGroup: false }] : []),
      ]);
    }

    let content = whatsAppToDiscord(msg.text);

    if (msg.quotedId) {
      const mapped = messages.byWaId(msg.quotedId, msg.jid);
      const link = mapped?.discord_id
        ? ` https://discord.com/channels/${config.guildId}/${chat.channel_id}/${mapped.discord_id}`
        : '';
      const quoted = msg.quotedText ? quoteBlock(whatsAppToDiscord(msg.quotedText)) : '> ↩︎';
      content = `${quoted}${link}\n${content}`;
    }

    const files = [];
    if (msg.media) {
      const { file, notice } = await fromWhatsApp(this.wa, msg);
      if (file) files.push(this.discord.attachment(file.buffer, file.name));
      if (notice) content = content ? `${content}\n${notice}` : notice;
    }

    if (!content && !files.length) return;

    const username = msg.fromMe ? 'You' : msg.senderName;
    const avatarURL = await this.#avatarFor(msg.fromMe ? this.wa.me || msg.senderJid : msg.senderJid);

    const pieces = content ? chunk(content) : [''];
    let last = null;
    for (let i = 0; i < pieces.length; i += 1) {
      last = await this.discord.postAs(chat, {
        username,
        avatarURL,
        content: pieces[i],
        files: i === pieces.length - 1 ? files : undefined,
      });
    }
    messages.link({ waId: msg.waId, waJid: msg.jid, discordId: last?.id, fromMe: msg.fromMe });
  }

  async #waEdit({ waId, jid, text }) {
    const mapped = messages.byWaId(waId, jid);
    const chat = chats.get(jid);
    if (!mapped?.discord_id || !chat) return;
    await this.discord.editPost(chat, mapped.discord_id, whatsAppToDiscord(text));
  }

  async #waRevoke({ waId, jid }) {
    const mapped = messages.byWaId(waId, jid);
    const chat = chats.get(jid);
    if (!mapped?.discord_id || !chat) return;
    await this.discord.deletePost(chat, mapped.discord_id);
  }

  async #waReaction({ waId, jid, emoji }) {
    const mapped = messages.byWaId(waId, jid);
    const chat = chats.get(jid);
    if (!mapped?.discord_id || !chat || !emoji) return;
    const channel = await this.discord.guild.channels.fetch(chat.channel_id).catch(() => null);
    const message = await channel?.messages.fetch(mapped.discord_id).catch(() => null);
    // Custom or non-unicode reactions are rejected by Discord; skip them.
    await message?.react(emoji).catch(() => {});
  }

  // --- Discord -> WhatsApp -------------------------------------------------

  #resolvers() {
    const client = this.discord.client;
    return {
      resolveUser: (id) => client.users.cache.get(id)?.username,
      resolveChannel: (id) => client.channels.cache.get(id)?.name,
      resolveRole: (id) => this.discord.guild?.roles.cache.get(id)?.name,
    };
  }

  async #discordToWa(message) {
    if (message.author?.bot || message.webhookId) return; // our own relayed posts
    const chat = chats.getByChannel(message.channelId);
    if (!chat) return;

    const text = discordToWhatsApp(message.content || '', this.#resolvers());

    let quoted;
    if (message.reference?.messageId) {
      const mapped = messages.byDiscordId(message.reference.messageId);
      if (mapped) {
        const referenced = await message.fetchReference().catch(() => null);
        quoted = {
          key: {
            remoteJid: chat.wa_jid,
            id: mapped.wa_id,
            fromMe: Boolean(mapped.from_me),
            ...(chat.is_group ? { participant: chat.wa_jid } : {}),
          },
          message: { conversation: referenced?.content || '' },
        };
      }
    }

    try {
      const sentIds = [];
      const attachments = [...message.attachments.values()];
      const isVoice = Boolean(message.flags?.has?.('IsVoiceMessage'));

      // Discord stickers and Tenor/Giphy links are not attachments, so they
      // need resolving before the attachment loop.
      const extras = await this.#richPayloads(message);
      for (const payload of extras.payloads) {
        const sent = await this.wa.send(chat.wa_jid, payload, quoted ? { quoted } : {});
        sentIds.push(sent?.key?.id);
      }

      for (let i = 0; i < attachments.length; i += 1) {
        // The caption rides on the first attachment so it is not sent twice.
        const payload = await toWhatsApp(attachments[i], {
          caption: i === 0 ? text : undefined,
          voice: isVoice,
        });
        const sent = await this.wa.send(chat.wa_jid, payload, quoted ? { quoted } : {});
        sentIds.push(sent?.key?.id);
      }

      if (!attachments.length) {
        if (!text.trim() || extras.textConsumed) {
          if (sentIds.length) {
            chats.touch(chat.wa_jid);
            messages.link({
              waId: sentIds.filter(Boolean).at(-1),
              waJid: chat.wa_jid,
              discordId: message.id,
              fromMe: true,
            });
          }
          return;
        }
        for (const piece of chunk(text, 4000)) {
          const sent = await this.wa.sendText(chat.wa_jid, piece, quoted);
          sentIds.push(sent?.key?.id);
        }
      }

      chats.touch(chat.wa_jid);
      const waId = sentIds.filter(Boolean).at(-1);
      messages.link({ waId, waJid: chat.wa_jid, discordId: message.id, fromMe: true });
      // Success is silent: only failures are worth marking.
    } catch (err) {
      logger.error({ err }, 'send to whatsapp failed');
      await message.react('❌').catch(() => {});
      await message.reply(`Could not send: ${err.message}`).catch(() => {});
    }
  }

  /**
   * Stickers, custom-emoji-only messages and GIF links, turned into Baileys
   * payloads. `textConsumed` says the text WAS the media (a bare GIF link or
   * a lone emoji), so it must not also be sent as a text message.
   */
  async #richPayloads(message) {
    const payloads = [];
    let textConsumed = false;

    for (const sticker of message.stickers?.values() ?? []) {
      const format = STICKER_FORMAT[sticker.format] || 'png';
      if (format === 'lottie') {
        // Animated Discord stickers are vector JSON; there is nothing to send.
        payloads.push({ text: `[sticker: ${sticker.name}]` });
        continue;
      }
      try {
        const webp = await toSticker(await download(sticker.url), format);
        if (webp) payloads.push({ sticker: webp });
        else payloads.push({ text: `[sticker: ${sticker.name}]` });
      } catch (err) {
        logger.warn({ err: err.message }, 'sticker relay failed');
        payloads.push({ text: `[sticker: ${sticker.name}]` });
      }
    }

    // A message of only custom emoji: send the images, since `:name:` alone
    // conveys nothing on WhatsApp.
    if (ONLY_CUSTOM_EMOJI.test(message.content?.trim() || '')) {
      for (const emoji of customEmojiIn(message.content).slice(0, 5)) {
        try {
          const webp = await toSticker(await download(emoji.url), emoji.animated ? 'gif' : 'png');
          if (webp) {
            payloads.push({ sticker: webp });
            textConsumed = true;
          }
        } catch (err) {
          logger.warn({ err: err.message }, 'emoji relay failed');
        }
      }
    }

    // Discord's GIF picker puts the link in the message content, but a link
    // that only resolves into an embed still needs relaying.
    const embedLinks = (message.embeds || []).flatMap((e) =>
      [e.url, e.video?.url, e.image?.url, e.thumbnail?.url].filter(Boolean).flatMap(findGifLinks),
    );
    const links = [...new Set([...findGifLinks(message.content), ...embedLinks])];

    for (const link of links.slice(0, 3)) {
      const payload = await gifLinkToWhatsApp(link);
      if (payload) {
        payloads.push(payload);
        // A message that was nothing but the link is now fully delivered.
        if (isOnlyGifLinks(message.content)) textConsumed = true;
      } else {
        logger.warn({ link }, 'gif could not be converted; sending the link as text');
      }
    }

    return { payloads, textConsumed };
  }

  async #discordEdit(message) {
    if (message.partial) message = await message.fetch().catch(() => null);
    if (!message || message.author?.bot || message.webhookId) return;
    const chat = chats.getByChannel(message.channelId);
    const mapped = messages.byDiscordId(message.id);
    if (!chat || !mapped?.wa_id || !mapped.from_me) return;
    await this.wa.editMessage(
      chat.wa_jid,
      mapped.wa_id,
      discordToWhatsApp(message.content || '', this.#resolvers()),
    );
  }

  async #discordDelete(message) {
    const chat = chats.getByChannel(message.channelId);
    const mapped = messages.byDiscordId(message.id);
    if (!chat || !mapped?.wa_id || !mapped.from_me) return;
    await this.wa.deleteMessage(chat.wa_jid, mapped.wa_id, true);
  }

  async #discordReaction(reaction, user) {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch().catch(() => {});
    const chat = chats.getByChannel(reaction.message.channelId);
    const mapped = messages.byDiscordId(reaction.message.id);
    if (!chat || !mapped?.wa_id) return;
    const emoji = reaction.emoji.id ? null : reaction.emoji.name; // custom emoji have no WA form
    if (!emoji || emoji === '❌') return; // our own delivery-failure marker
    await this.wa.react(chat.wa_jid, mapped.wa_id, emoji, Boolean(mapped.from_me));
  }
}

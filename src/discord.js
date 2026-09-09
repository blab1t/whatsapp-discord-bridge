import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  WebhookClient,
  AttachmentBuilder,
  PermissionFlagsBits,
  Routes,
} from 'discord.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { chats } from './db.js';

const CATEGORY_LIMIT = 50; // Discord's hard cap on channels per category

/** Discord channel names: lowercase, no spaces, <=100 chars, must be non-empty. */
export function slugify(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return slug || 'chat';
}

export class Discord {
  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        // Privileged: required for the join allowlist. Enable "Server Members
        // Intent" in the Developer Portal or login fails.
        GatewayIntentBits.GuildMembers,
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });
    this.guild = null;
    this.controlChannel = null;
    this.webhooks = new Map(); // waJid -> WebhookClient
    this.creating = new Map(); // waJid -> in-flight promise, prevents duplicate channels
  }

  async start() {
    try {
      await this.client.login(config.discordToken);
    } catch (err) {
      if (String(err.message).includes('disallowed intents')) {
        throw new Error(
          'Discord rejected the login: enable "Server Members Intent" and "Message Content Intent" ' +
            'under Bot in the Developer Portal, then start again.',
        );
      }
      throw err;
    }
    await new Promise((resolve) => {
      if (this.client.isReady()) resolve();
      else this.client.once('clientReady', resolve);
    });
    this.guild = await this.client.guilds.fetch(config.guildId);
    this.controlChannel = await this.#ensureControlChannel();
    logger.info(`Discord ready as ${this.client.user.tag} in ${this.guild.name}`);
    if (config.autoBan) this.#enforceAllowlist();
    await this.lockChannels();
  }

  /**
   * Deny @everyone the ability to see a channel. Administrators bypass channel
   * overwrites entirely, so this leaves the server readable to admins only.
   */
  #privateOverwrites() {
    return [{ id: this.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }];
  }

  /** Apply that to every existing channel, including ones created earlier. */
  async lockChannels() {
    const everyone = this.guild.roles.everyone.id;
    const channels = await this.guild.channels.fetch();
    let locked = 0;
    for (const channel of channels.values()) {
      if (!channel) continue;
      const current = channel.permissionOverwrites?.cache.get(everyone);
      if (current?.deny.has(PermissionFlagsBits.ViewChannel)) continue;
      try {
        await channel.permissionOverwrites.edit(everyone, { ViewChannel: false });
        locked += 1;
      } catch (err) {
        logger.warn({ err: err.message, channel: channel.name }, 'could not lock channel');
      }
    }
    if (locked) logger.info(`locked ${locked} channels to admins only`);
    return locked;
  }

  /**
   * Ban anyone who joins who is not the bot, the server owner, or explicitly
   * allowed. This is a private, single-user server by design.
   */
  #enforceAllowlist() {
    const allowed = new Set([...config.allowedUserIds, this.client.user.id]);
    logger.info(`join allowlist active for ${[...allowed].join(', ')}`);

    this.client.on('guildMemberAdd', async (member) => {
      if (member.guild.id !== this.guild.id) return;
      if (allowed.has(member.id)) return;
      // The owner cannot be banned, and banning yourself out of your own
      // server would be unrecoverable.
      if (member.id === member.guild.ownerId) {
        await this.control(`⚠️ ${member.user.tag} joined and is the server owner — not banned.`);
        return;
      }
      try {
        await member.ban({ reason: 'Not on the bridge allowlist' });
        await this.control(`🔨 Banned ${member.user.tag} (${member.id}) — not on the allowlist.`);
      } catch (err) {
        logger.error({ err }, 'allowlist ban failed');
        await this.control(`⚠️ Could not ban ${member.user.tag} (${member.id}): ${err.message}`);
      }
    });
  }

  /**
   * Mirror your WhatsApp identity onto your Discord server profile.
   *
   * Only the nickname is possible: Discord exposes no API for setting another
   * user's per-server avatar (it is a Nitro client feature), and it refuses
   * nickname changes on the server owner regardless of permissions.
   */
  async mirrorProfile({ name }) {
    if (!config.mirrorProfile || !name) return;

    for (const userId of config.allowedUserIds) {
      const member = await this.guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      if (member.nickname === name) continue;

      if (member.id === this.guild.ownerId) {
        if (!this.ownerNickWarned) {
          this.ownerNickWarned = true;
          await this.control(
            `ℹ️ Cannot set your nickname to *${name}*: Discord does not let bots rename the server owner. ` +
              'Transfer ownership, or set the nickname yourself. ' +
              'Your server avatar cannot be set by any bot — that is a Nitro-only client feature.',
          );
        }
        continue;
      }

      try {
        await member.setNickname(name.slice(0, 32), 'Mirroring WhatsApp profile');
        logger.info(`set ${member.user.tag} nickname to ${name}`);
      } catch (err) {
        logger.warn({ err: err.message }, 'nickname mirror failed');
        await this.control(`⚠️ Could not set your nickname to *${name}*: ${err.message}`);
      }
    }
  }

  async #ensureControlChannel() {
    const channels = await this.guild.channels.fetch();
    const existing = channels.find(
      (c) => c?.type === ChannelType.GuildText && c.name === config.controlChannelName,
    );
    if (existing) return existing;
    return this.guild.channels.create({
      name: config.controlChannelName,
      type: ChannelType.GuildText,
      topic: 'WhatsApp bridge status, login QR codes and errors',
      permissionOverwrites: this.#privateOverwrites(),
    });
  }

  async control(content, files) {
    try {
      await this.controlChannel.send({ content, files });
    } catch (err) {
      logger.error({ err }, 'failed posting to control channel');
    }
  }

  /** Find a category of `prefix N` with room, creating the next one when full. */
  async #pickCategory(prefix) {
    const channels = await this.guild.channels.fetch();
    const categories = [...channels.values()]
      .filter((c) => c?.type === ChannelType.GuildCategory && c.name.startsWith(`${prefix} `))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    for (const category of categories) {
      const used = [...channels.values()].filter((c) => c?.parentId === category.id).length;
      if (used < CATEGORY_LIMIT) return category;
    }
    return this.guild.channels.create({
      name: `${prefix} ${categories.length + 1}`,
      type: ChannelType.GuildCategory,
      permissionOverwrites: this.#privateOverwrites(),
    });
  }

  /**
   * Return the chat row for a WhatsApp jid, creating the channel and webhook
   * on first use. Concurrent calls for the same jid share one creation.
   */
  async getOrCreateChat({ waJid, name, isGroup }) {
    const existing = chats.get(waJid);
    if (existing?.channel_id) {
      const live = await this.guild.channels.fetch(existing.channel_id).catch(() => null);
      if (live) {
        if (existing.archived) await this.unarchive(existing, live);
        return existing;
      }
      chats.remove(waJid); // channel deleted by hand; rebuild it
    }

    if (this.creating.has(waJid)) return this.creating.get(waJid);
    const job = this.#createChat({ waJid, name, isGroup }).finally(() => this.creating.delete(waJid));
    this.creating.set(waJid, job);
    return job;
  }

  async #createChat({ waJid, name, isGroup }) {
    const category = await this.#pickCategory(config.categoryPrefix);
    const channel = await this.guild.channels.create({
      name: slugify(name),
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `${isGroup ? 'Group' : 'Chat'}: ${name} — ${waJid}`,
      permissionOverwrites: this.#privateOverwrites(),
    });
    const webhook = await channel.createWebhook({ name: 'WhatsApp Bridge' });
    logger.info(`bridged ${name} (${waJid}) -> #${channel.name}`);
    return chats.upsert({
      waJid,
      channelId: channel.id,
      webhookId: webhook.id,
      webhookToken: webhook.token,
      name,
      isGroup,
    });
  }

  #webhookFor(chat) {
    let hook = this.webhooks.get(chat.wa_jid);
    if (!hook) {
      hook = new WebhookClient({ id: chat.webhook_id, token: chat.webhook_token });
      this.webhooks.set(chat.wa_jid, hook);
    }
    return hook;
  }

  /**
   * Post as the WhatsApp sender (their name and avatar) via the chat webhook.
   * Mentions are disabled: relayed text must never ping the Discord user.
   */
  async postAs(chat, { username, avatarURL, content, files }) {
    const hook = this.#webhookFor(chat);
    try {
      return await hook.send({
        username: (username || 'WhatsApp').slice(0, 80),
        avatarURL: avatarURL || undefined,
        content: content || undefined,
        files,
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      if (err.code === 10015) {
        // Unknown Webhook: recreated by hand or deleted. Rebuild and retry once.
        this.webhooks.delete(chat.wa_jid);
        const channel = await this.guild.channels.fetch(chat.channel_id);
        const webhook = await channel.createWebhook({ name: 'WhatsApp Bridge' });
        const updated = chats.upsert({
          waJid: chat.wa_jid,
          channelId: chat.channel_id,
          webhookId: webhook.id,
          webhookToken: webhook.token,
          name: chat.name,
          isGroup: chat.is_group,
        });
        return this.#webhookFor(updated).send({
          username: (username || 'WhatsApp').slice(0, 80),
          avatarURL: avatarURL || undefined,
          content: content || undefined,
          files,
          allowedMentions: { parse: [] },
        });
      }
      throw err;
    }
  }

  /** Edit a relayed message. Only the webhook that created it may edit it. */
  async editPost(chat, messageId, content) {
    try {
      await this.#webhookFor(chat).editMessage(messageId, { content: content || '​' });
    } catch (err) {
      logger.warn({ err }, 'webhook edit failed');
    }
  }

  async deletePost(chat, messageId) {
    try {
      await this.#webhookFor(chat).deleteMessage(messageId);
    } catch (err) {
      logger.warn({ err }, 'webhook delete failed');
    }
  }

  attachment(buffer, name) {
    return new AttachmentBuilder(buffer, { name });
  }

  async unarchive(chat, channel) {
    try {
      const category = await this.#pickCategory(config.categoryPrefix);
      const live = channel ?? (await this.guild.channels.fetch(chat.channel_id));
      if (live.parentId !== category.id) await live.setParent(category.id, { lockPermissions: false });
      chats.setArchived(chat.wa_jid, false);
    } catch (err) {
      logger.error({ err }, 'unarchive failed');
    }
  }

  /** Move one chat's channel into an Archive category. */
  async archiveChat(chat) {
    const channel = await this.guild.channels.fetch(chat.channel_id).catch(() => null);
    if (!channel) {
      chats.setArchived(chat.wa_jid, true);
      return null;
    }
    const category = await this.#pickCategory(config.archivePrefix);
    await channel.setParent(category.id, { lockPermissions: false });
    chats.setArchived(chat.wa_jid, true);
    return channel;
  }

  /** Delete a chat's channel and stop relaying it. The WhatsApp chat is untouched. */
  async deleteChat(chat, reason = 'Deleted from Discord') {
    const channel = await this.guild.channels.fetch(chat.channel_id).catch(() => null);
    this.webhooks.delete(chat.wa_jid);
    chats.remove(chat.wa_jid);
    if (channel) await channel.delete(reason);
    return Boolean(channel);
  }

  /** Move channels with no traffic for ARCHIVE_AFTER_DAYS into an Archive category. */
  async archiveStale() {
    const cutoff = Math.floor(Date.now() / 1000) - config.archiveAfterDays * 86400;
    const stale = chats.staleBefore(cutoff);
    if (!stale.length) return 0;

    let moved = 0;
    for (const chat of stale) {
      try {
        const channel = await this.guild.channels.fetch(chat.channel_id).catch(() => null);
        if (!channel) {
          chats.remove(chat.wa_jid);
          continue;
        }
        const category = await this.#pickCategory(config.archivePrefix);
        await channel.setParent(category.id, { lockPermissions: false });
        chats.setArchived(chat.wa_jid, true);
        moved += 1;
      } catch (err) {
        logger.warn({ err, chat: chat.name }, 'archive failed');
      }
    }
    if (moved) logger.info(`archived ${moved} idle channels`);
    return moved;
  }
}

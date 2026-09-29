import { REST, Routes, SlashCommandBuilder, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { chats, scheduled, contacts, searchDirectory, lookupJid } from './db.js';
import { discordToWhatsApp } from './format.js';
import { parseWhen, formatWhen, WHEN_HELP } from './when.js';

export const definitions = [
  new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('Send a WhatsApp message to this chat later')
    .addStringOption((o) =>
      o.setName('when').setDescription('in 2h · tomorrow 09:00 · 2026-09-08 14:30').setRequired(true),
    )
    .addStringOption((o) => o.setName('text').setDescription('Message to send').setRequired(true)),

  new SlashCommandBuilder()
    .setName('scheduled')
    .setDescription('List pending scheduled messages for this chat'),

  new SlashCommandBuilder()
    .setName('cancel')
    .setDescription('Cancel a scheduled message')
    .addIntegerOption((o) => o.setName('id').setDescription('Scheduled message id').setRequired(true)),

  new SlashCommandBuilder().setName('status').setDescription('Bridge status'),

  new SlashCommandBuilder().setName('qr').setDescription('Post a fresh WhatsApp login QR code'),

  new SlashCommandBuilder()
    .setName('pair')
    .setDescription('Link WhatsApp with an 8-character code instead of a QR')
    .addStringOption((o) =>
      o
        .setName('number')
        .setDescription('Your WhatsApp number, international, digits only (e.g. 4915123456789)')
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Search your WhatsApp contacts and groups, and open that chat')
    .addStringOption((o) =>
      o
        .setName('who')
        .setDescription('Start typing a name, or paste a phone number with country code')
        .setRequired(true)
        .setAutocomplete(true),
    ),

  new SlashCommandBuilder()
    .setName('sync')
    .setDescription('Refresh the contact and group directory from WhatsApp'),

  new SlashCommandBuilder()
    .setName('archive')
    .setDescription('Move this channel to the Archive category (it returns on the next message)'),

  new SlashCommandBuilder()
    .setName('delete')
    .setDescription('Delete this channel and stop relaying it. The WhatsApp chat is not touched')
    .addBooleanOption((o) =>
      o
        .setName('confirm')
        .setDescription('Yes, delete this channel and its message history')
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName('unbridge')
    .setDescription('Stop relaying this channel (channel and history are kept)'),
].map((c) => c.toJSON());

export async function register() {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
    body: definitions,
  });
  logger.info(`registered ${definitions.length} slash commands`);
}

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

export function attach({ client, wa, discord }) {
  client.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) {
      await autocomplete(interaction).catch((err) => logger.error({ err }, 'autocomplete failed'));
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    try {
      await handle(interaction, { wa, discord });
    } catch (err) {
      logger.error({ err, command: interaction.commandName }, 'command failed');
      const body = ephemeral(`Something went wrong: ${err.message}`);
      if (interaction.deferred || interaction.replied) await interaction.followUp(body).catch(() => {});
      else await interaction.reply(body).catch(() => {});
    }
  });
}

/** Turn a directory row into a Discord choice label of at most 100 chars. */
function choiceLabel(row) {
  const number = row.wa_jid.split('@')[0];
  const name = row.name && row.name !== number ? row.name : null;
  const kind = row.is_group ? '👥' : '👤';
  const open = row.channel_id ? ' • open' : '';
  const label = name ? `${kind} ${name} (+${number})${open}` : `${kind} +${number}${open}`;
  return label.slice(0, 100);
}

async function autocomplete(interaction) {
  if (interaction.commandName !== 'chat') return interaction.respond([]);
  const typed = interaction.options.getFocused();
  const rows = searchDirectory(typed, 25);

  const choices = rows.map((row) => ({ name: choiceLabel(row), value: row.wa_jid }));

  // A number that matches nobody in the address book is still worth offering:
  // it may be someone not saved as a contact.
  const digits = String(typed).replace(/[^\d]/g, '');
  if (digits.length >= 7 && !choices.some((c) => c.value.startsWith(`${digits}@`))) {
    choices.unshift({ name: `👤 +${digits} (not in contacts)`, value: `${digits}@s.whatsapp.net` });
  }

  return interaction.respond(choices.slice(0, 25));
}

async function handle(interaction, { wa, discord }) {
  const chat = chats.getByChannel(interaction.channelId);

  switch (interaction.commandName) {
    case 'schedule': {
      if (!chat) return interaction.reply(ephemeral('Run this in a bridged WhatsApp channel.'));
      let at;
      try {
        at = parseWhen(interaction.options.getString('when'));
      } catch (err) {
        return interaction.reply(ephemeral(err.message));
      }
      const body = discordToWhatsApp(interaction.options.getString('text'));
      const sendAt = Math.floor(at.getTime() / 1000);
      const id = scheduled.add({
        waJid: chat.wa_jid,
        channelId: interaction.channelId,
        body,
        sendAt,
        createdBy: interaction.user.id,
      });
      return interaction.reply(
        `⏰ Scheduled **#${id}** to *${chat.name}* for ${formatWhen(sendAt)}\n> ${body.slice(0, 300)}`,
      );
    }

    case 'scheduled': {
      const rows = scheduled.pendingForChannel(interaction.channelId);
      if (!rows.length) return interaction.reply(ephemeral('Nothing scheduled for this chat.'));
      const list = rows
        .map((r) => `**#${r.id}** ${formatWhen(r.send_at)}\n> ${r.body.slice(0, 150)}`)
        .join('\n\n');
      return interaction.reply(ephemeral(list.slice(0, 1900)));
    }

    case 'cancel': {
      const id = interaction.options.getInteger('id');
      const removed = scheduled.cancel(id, interaction.channelId);
      return interaction.reply(
        ephemeral(removed ? `Cancelled #${id}.` : `No pending message #${id} in this channel.`),
      );
    }

    case 'status': {
      const uptime = wa.connectedAt ? Math.floor((Date.now() - wa.connectedAt) / 1000) : 0;
      const all = chats.all();
      return interaction.reply(
        ephemeral(
          [
            `**WhatsApp:** ${wa.state}${uptime ? ` (up ${Math.floor(uptime / 60)} min)` : ''}`,
            `**Account:** ${wa.me || 'not linked'}`,
            `**Bridged chats:** ${all.length} (${all.filter((c) => c.archived).length} archived)`,
            `**Contacts known:** ${contacts.count()}`,
            `**Scheduled pending:** ${scheduled.pendingCount()}`,
            `**Timezone:** ${config.timezone}`,
            '',
            WHEN_HELP,
          ].join('\n'),
        ),
      );
    }

    case 'qr': {
      await interaction.reply(ephemeral(`Requesting a fresh QR — it will appear in #${config.controlChannelName}.`));
      wa.requestQr();
      return undefined;
    }

    case 'pair': {
      const digits = (interaction.options.getString('number') || config.pairNumber || '').replace(
        /[^0-9]/g,
        '',
      );
      if (digits.length < 8 || digits.length > 15) {
        return interaction.reply(
          ephemeral(
            'Give your WhatsApp number in international form, digits only, e.g. `/pair number:4915123456789`.',
          ),
        );
      }
      await interaction.reply(
        ephemeral(
          `Re-linking +${digits}. The code will appear in #${config.controlChannelName} in a few seconds.
` +
            'This drops the current WhatsApp session.',
        ),
      );
      await wa.startPairing(digits);
      return undefined;
    }

    case 'chat': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const who = interaction.options.getString('who').trim();

      // Autocomplete hands back a jid; free text is searched, and a bare
      // number is checked against WhatsApp directly.
      let target = null;
      if (who.includes('@')) {
        // Autocomplete hands back an exact jid, so look it up exactly. Using a
        // search here let a person inherit an unrelated group's name.
        const known = lookupJid(who);
        target = {
          waJid: who,
          name: known?.name || who.split('@')[0],
          isGroup: who.endsWith('@g.us'),
        };
      } else {
        const hit = searchDirectory(who, 1)[0];
        if (hit) {
          target = { waJid: hit.wa_jid, name: hit.name || hit.wa_jid.split('@')[0], isGroup: Boolean(hit.is_group) };
        } else {
          const digits = who.replace(/[^\d]/g, '');
          if (digits.length < 7 || digits.length > 15) {
            return interaction.editReply(
              `Nothing matches "${who}". Pick from the suggestions, or paste a full phone number with country code.`,
            );
          }
          const found = await wa.exists(digits);
          if (!found) return interaction.editReply(`+${digits} is not on WhatsApp.`);
          target = { waJid: found, name: digits, isGroup: false };
        }
      }

      const created = await discord.getOrCreateChat(target);
      return interaction.editReply(`*${created.name}* → <#${created.channel_id}>`);
    }

    case 'sync': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const before = contacts.count();
      await wa.syncDirectory();
      const after = contacts.count();
      return interaction.editReply(
        `Directory refreshed: ${after} entries (${after - before >= 0 ? '+' : ''}${after - before}).
` +
          'Contact *names* only ever arrive on a fresh link — unlink in WhatsApp → Linked devices and run `/qr` to pull them all.',
      );
    }

    case 'archive': {
      if (!chat) return interaction.reply(ephemeral('This channel is not bridged.'));
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await discord.archiveChat(chat);
      return interaction.editReply(
        `Archived *${chat.name}*. It moves back automatically on the next message.`,
      );
    }

    case 'delete': {
      if (!interaction.options.getBoolean('confirm')) {
        return interaction.reply(ephemeral('Not deleted. Pass `confirm: True` if you mean it.'));
      }
      if (!chat) {
        // Unbridged channels (an old LID duplicate, say) are still deletable.
        await interaction.reply(ephemeral('Not a bridged channel — deleting it anyway.'));
        await interaction.channel?.delete('Deleted from Discord').catch(() => {});
        return undefined;
      }
      // Reply before deleting: the channel is gone by the time Discord would
      // deliver a follow-up to it.
      await interaction.reply(
        ephemeral(`Deleting *${chat.name}*. The WhatsApp chat itself is untouched.`),
      );
      await discord.deleteChat(chat);
      return undefined;
    }

    case 'unbridge': {
      if (!chat) return interaction.reply(ephemeral('This channel is not bridged.'));
      chats.remove(chat.wa_jid);
      return interaction.reply(`Stopped relaying *${chat.name}*. Channel and history kept.`);
    }

    default:
      // Discord keeps commands registered after the process that registered
      // them exits, so this almost always means the running bridge is older
      // than the code that added the command.
      logger.warn({ command: interaction.commandName }, 'no handler for command');
      return interaction.reply(
        ephemeral(
          `No handler for \`/${interaction.commandName}\` — this bridge is running an older build than the one that registered it. Restart the bridge.`,
        ),
      );
  }
}

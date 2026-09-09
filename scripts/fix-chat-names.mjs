/**
 * Repair chat names that were taken from the wrong row.
 *   node scripts/fix-chat-names.mjs [--apply]
 *
 * An earlier bug matched a typed phone number anywhere inside a jid, so a
 * group (id 120363<digits>@g.us) could lend its name to a person whose number
 * appeared in it. Runs a dry run unless --apply is passed.
 */
import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { chats, lookupJid, db } from '../src/db.js';
import { slugify } from '../src/discord.js';

const apply = process.argv.includes('--apply');

const wrong = [];
for (const chat of chats.all()) {
  // The contacts table is the authority on what a jid is actually called.
  const truth = db.prepare('SELECT name FROM contacts WHERE wa_jid = ?').get(chat.wa_jid);
  const realName = truth?.name;
  if (!realName || realName === chat.name) continue;
  wrong.push({ chat, realName });
}

if (!wrong.length) {
  console.log('no mismatched chat names found');
  process.exit(0);
}

for (const { chat, realName } of wrong) {
  console.log(`${chat.wa_jid}\n  named "${chat.name}" but is "${realName}"`);
}
if (!apply) {
  console.log(`\n${wrong.length} to fix. Re-run with --apply to rename them.`);
  process.exit(0);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(process.env.DISCORD_TOKEN);
await new Promise((resolve) => client.once('clientReady', resolve));
const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);

for (const { chat, realName } of wrong) {
  db.prepare('UPDATE chats SET name = ? WHERE wa_jid = ?').run(realName, chat.wa_jid);
  const channel = await guild.channels.fetch(chat.channel_id).catch(() => null);
  if (!channel) {
    console.log(`renamed in database only (channel gone): ${realName}`);
    continue;
  }
  await channel.setName(slugify(realName)).catch((err) => console.log(`  channel rename failed: ${err.message}`));
  await channel
    .setTopic(`${chat.is_group ? 'Group' : 'Chat'}: ${realName} — ${chat.wa_jid}`)
    .catch(() => {});
  console.log(`renamed #${channel.name} -> ${realName}`);
}

client.destroy();
process.exit(0);

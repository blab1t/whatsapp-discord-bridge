/**
 * Set the bot's avatar from an image file.
 *   node scripts/set-bot-avatar.mjs path/to/logo.png
 *
 * A one-off: Discord stores the avatar, so the bridge itself never touches it.
 * Discord rate-limits avatar changes to a couple per hour.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/set-bot-avatar.mjs <image file>');
  process.exit(1);
}

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };
const ext = path.extname(file).toLowerCase();
const mime = TYPES[ext];
if (!mime) {
  console.error(`unsupported image type "${ext}" — use png, jpg or gif`);
  process.exit(1);
}

const buffer = readFileSync(file);
if (buffer.length > 10 * 1024 * 1024) {
  console.error('image is over Discord\'s 10 MB avatar limit');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(process.env.DISCORD_TOKEN);
await new Promise((resolve) => client.once('clientReady', resolve));

try {
  await client.user.setAvatar(`data:${mime};base64,${buffer.toString('base64')}`);
  console.log(`avatar set for ${client.user.tag} from ${path.basename(file)}`);
} catch (err) {
  console.error(`could not set avatar: ${err.message}`);
  process.exitCode = 1;
}

client.destroy();
process.exit(process.exitCode ?? 0);

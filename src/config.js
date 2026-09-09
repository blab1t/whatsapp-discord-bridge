import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`\nMissing required env var ${name}. Copy .env.example to .env and fill it in.\n`);
    process.exit(1);
  }
  return value;
}

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
mkdirSync(dataDir, { recursive: true });

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  clientId: required('DISCORD_CLIENT_ID'),
  guildId: required('DISCORD_GUILD_ID'),

  dataDir,
  authDir: path.join(dataDir, 'auth'),
  dbPath: path.join(dataDir, 'bot.db'),

  timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  archiveAfterDays: Number(process.env.ARCHIVE_AFTER_DAYS || 30),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 10),
  messageRetentionDays: Number(process.env.MESSAGE_RETENTION_DAYS || 90),
  logLevel: process.env.LOG_LEVEL || 'info',

  // Anyone who joins and is not the bot, the server owner, or on this list is
  // banned on sight. Comma-separated Discord user ids.
  autoBan: process.env.AUTO_BAN !== 'false',
  allowedUserIds: (process.env.ALLOWED_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),

  // Show the bot as your WhatsApp name and profile picture.
  mirrorProfile: process.env.MIRROR_PROFILE !== 'false',

  // Pull chat history on link. This is what delivers your contact names, so
  // turning it off leaves /chat able to search only numbers and groups.
  syncHistory: process.env.SYNC_HISTORY !== 'false',

  controlChannelName: 'wa-control',
  categoryPrefix: 'WhatsApp',
  archivePrefix: 'Archive',
};

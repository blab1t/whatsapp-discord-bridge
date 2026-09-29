import QRCode from 'qrcode';
import qrTerminal from 'qrcode-terminal';
import { config } from './config.js';
import { logger } from './logger.js';
import { messages, contacts, chats, now } from './db.js';
import { WhatsApp } from './whatsapp.js';
import { Discord } from './discord.js';
import { Bridge } from './bridge.js';
import { Scheduler } from './schedule.js';
import * as commands from './commands.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS_TEXT = {
  open: '🟢 Connected to WhatsApp.',
  closed: '🟠 Disconnected — reconnecting.',
  'logged-out': '🔴 Logged out. Scan the QR below to relink.',
  conflict: '🔴 Another copy of the bridge is running with this WhatsApp session. Stop it, then restart this one.',
};

async function main() {
  const discord = new Discord();
  await discord.start();

  const wa = new WhatsApp();

  // Baileys emits a new QR every ~20 seconds. Posting each one buries the live
  // code under dead ones, and scanning a dead code hangs the phone forever, so
  // only the newest is kept.
  let lastQrMessage = null;
  wa.on('qr', async (qr) => {
    if (config.pairNumber) return; // pairing by code instead
    qrTerminal.generate(qr, { small: true });
    logger.info('Scan the QR above. It is replaced every ~20s - use the newest.');
    try {
      const png = await QRCode.toBuffer(qr, { width: 512, margin: 2 });
      await lastQrMessage?.delete().catch(() => {});
      lastQrMessage = await discord.controlMessage(
        [
          'Scan in WhatsApp → **Settings → Linked devices → Link a device**.',
          'This replaces itself every ~20s — always scan the newest.',
          'Easier: set `PAIR_NUMBER` in .env and use `/pair`.',
        ].join('\n'),
        [discord.attachment(png, 'whatsapp-qr.png')],
      );
    } catch (err) {
      logger.error({ err }, 'failed to post QR to Discord');
    }
  });

  wa.on('pairing-code', (code, number) => {
    logger.info(`PAIRING CODE for +${number}: ${code}`);
    discord.control(
      [
        `**Pairing code: \`${code}\`**`,
        `On your phone: WhatsApp → **Settings → Linked devices → Link a device → Link with phone number instead**, then enter this code for +${number}.`,
        'It is valid for a few minutes. Run `/pair` for a new one.',
      ].join('\n'),
    );
  });

  wa.on('status', async (state, detail) => {
    logger.info({ state, detail }, 'whatsapp status');
    const text = STATUS_TEXT[state] || `WhatsApp: ${state}`;
    discord.control(detail ? `${text}\n\`${detail}\`` : text);

    // Once linked, mirror your WhatsApp name onto your server profile.
    if (state === 'open') await discord.mirrorProfile({ name: wa.displayName });
  });

  // Keep the searchable address book in step with WhatsApp.
  wa.on('contacts', (list) => {
    try {
      contacts.upsertMany(list);
    } catch (err) {
      logger.error({ err }, 'contact sync failed');
    }
  });

  // A LID chat and a phone-number chat can be the same person. Once the
  // mapping is known, fold them together so no contact has two channels.
  wa.on('lids-resolved', (pairs) => {
    for (const { lid, jid } of pairs) {
      if (!chats.get(lid)) continue;
      if (chats.get(jid)) {
        chats.remove(lid);
        logger.warn({ lid, jid }, 'duplicate channel for one contact; keeping the phone-number one');
      } else {
        chats.remap(lid, jid);
        logger.info({ lid, jid }, 'merged LID chat into phone number');
      }
    }
  });

  new Bridge(wa, discord).attach();

  const scheduler = new Scheduler(wa, discord);
  scheduler.start();

  await commands.register();
  commands.attach({ client: discord.client, wa, discord });

  // Housekeeping: prune old id mappings, then archive idle channels daily.
  const pruned = messages.prune(now() - config.messageRetentionDays * 86400);
  if (pruned) logger.info(`pruned ${pruned} old message mappings`);
  const housekeeping = setInterval(() => {
    messages.prune(now() - config.messageRetentionDays * 86400);
    discord.archiveStale().catch((err) => logger.error({ err }, 'archive sweep failed'));
  }, DAY_MS);
  discord.archiveStale().catch((err) => logger.error({ err }, 'archive sweep failed'));

  await wa.start();

  const shutdown = () => {
    logger.info('shutting down');
    clearInterval(housekeeping);
    scheduler.stop();
    discord.client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// A bridge that dies on one bad message is worse than one that logs and lives.
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
process.on('uncaughtException', (err) => logger.error({ err }, 'uncaught exception'));

main().catch((err) => {
  logger.error({ err }, 'startup failed');
  process.exit(1);
});

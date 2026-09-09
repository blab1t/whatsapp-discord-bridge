import { logger } from './logger.js';
import { scheduled, chats } from './db.js';

export { parseWhen, formatWhen, WHEN_HELP } from './when.js';

const TICK_MS = 30_000;
const LATE_THRESHOLD_S = 300;

/** Poll for due messages and deliver them. State lives in SQLite, so restarts are safe. */
export class Scheduler {
  constructor(wa, discord) {
    this.wa = wa;
    this.discord = discord;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((err) => logger.error({ err }, 'tick')), TICK_MS);
    this.tick().catch((err) => logger.error({ err }, 'tick'));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.wa.state !== 'open') return; // retry on the next tick once reconnected
    for (const row of scheduled.due()) {
      await this.#deliver(row);
    }
  }

  async #deliver(row) {
    const channel = await this.discord.guild.channels.fetch(row.channel_id).catch(() => null);
    try {
      await this.wa.sendText(row.wa_jid, row.body);
      scheduled.markSent(row.id);
      chats.touch(row.wa_jid);

      const lateBy = Math.floor(Date.now() / 1000) - row.send_at;
      const late = lateBy > LATE_THRESHOLD_S ? ` (sent ${Math.round(lateBy / 60)} min late — bridge was offline)` : '';
      await channel?.send(`⏰ Scheduled message #${row.id} sent${late}.`).catch(() => {});
    } catch (err) {
      logger.error({ err, id: row.id }, 'scheduled send failed');
      scheduled.markFailed(row.id, err.message);
      await channel?.send(`⚠️ Scheduled message #${row.id} failed: ${err.message}`).catch(() => {});
    }
  }
}

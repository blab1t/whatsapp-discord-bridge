/**
 * Parsing and rendering of scheduling expressions. Pure, no I/O, no config —
 * which is what lets the tests import it without a live environment.
 */

export const WHEN_HELP = [
  'Accepted forms:',
  '  `in 30m` · `in 2h` · `in 3d` (s/m/h/d/w)',
  '  `today 18:30` · `tomorrow 09:00`',
  '  `18:30` (next time it comes round)',
  '  `2026-09-08 14:30`',
].join('\n');

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** Every spelling accepted after `in <n>`, mapped to seconds. */
const UNIT_WORDS = Object.fromEntries(
  [
    ['s', 'sec', 'secs', 'second', 'seconds'],
    ['m', 'min', 'mins', 'minute', 'minutes'],
    ['h', 'hr', 'hrs', 'hour', 'hours'],
    ['d', 'day', 'days'],
    ['w', 'wk', 'wks', 'week', 'weeks'],
  ].flatMap((words) => words.map((w) => [w, UNIT_SECONDS[words[0]]])),
);

/**
 * Parse a scheduling expression into a Date. Local time, so set TZ in .env.
 * @throws {Error} with the accepted forms when nothing matches
 */
export function parseWhen(input, now = new Date()) {
  const text = String(input || '').trim().toLowerCase();

  const relative = text.match(/^in\s+(\d+)\s*([a-z]+)$/);
  if (relative) {
    const unit = UNIT_WORDS[relative[2]];
    if (!unit) throw new Error(`Unknown unit "${relative[2]}".
${WHEN_HELP}`);
    const seconds = Number(relative[1]) * unit;
    if (seconds <= 0) throw new Error('That time is not in the future.');
    return new Date(now.getTime() + seconds * 1000);
  }

  const named = text.match(/^(today|tomorrow)\s+(\d{1,2}):(\d{2})$/);
  if (named) {
    const date = new Date(now);
    if (named[1] === 'tomorrow') date.setDate(date.getDate() + 1);
    date.setHours(Number(named[2]), Number(named[3]), 0, 0);
    assertFuture(date, now);
    return date;
  }

  const timeOnly = text.match(/^(\d{1,2}):(\d{2})$/);
  if (timeOnly) {
    const date = new Date(now);
    date.setHours(Number(timeOnly[1]), Number(timeOnly[2]), 0, 0);
    if (date <= now) date.setDate(date.getDate() + 1); // next time it comes round
    return date;
  }

  const absolute = text.match(/^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/);
  if (absolute) {
    const [, y, mo, d, h, mi] = absolute.map(Number);
    const date = new Date(y, mo - 1, d, h, mi, 0, 0);
    if (Number.isNaN(date.getTime())) throw new Error(`Could not read that date.\n${WHEN_HELP}`);
    assertFuture(date, now);
    return date;
  }

  throw new Error(`Could not read "${input}".\n${WHEN_HELP}`);
}

function assertFuture(date, now) {
  if (date <= now) throw new Error('That time is already past.');
}

export function formatWhen(unixSeconds) {
  return `<t:${unixSeconds}:F> (<t:${unixSeconds}:R>)`; // Discord renders in the viewer's timezone
}

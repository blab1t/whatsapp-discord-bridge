/**
 * Text formatting conversion between Discord and WhatsApp markup.
 *
 * Both directions parse into the same intermediate sentinels, then render.
 * The trap this exists to avoid: Discord's `*x*` is italic, WhatsApp's `*x*`
 * is bold. Converting naively swaps emphasis on every message.
 *
 * Pure functions, no I/O.
 */

// Intermediate sentinels: control chars that never appear in real messages.
const B0 = '\u0011';
const B1 = '\u0012';
const I0 = '\u0013';
const I1 = '\u0014';
const S0 = '\u0015';
const S1 = '\u0016';
const P0 = '\u0017'; // protected-span placeholder delimiters
const P1 = '\u0018';

const SENTINELS = [B0, B1, I0, I1, S0, S1, P0, P1];

const URL_RE = /\bhttps?:\/\/\S+/gi;
const CODE_RE = /```[\s\S]*?```|`[^`\n]+`/g;
const PLACEHOLDER_RE = new RegExp(`${P0}(\\d+)${P1}`, 'g');

/** Replace protected spans (code, URLs) with placeholders so markup inside them survives. */
function protect(text) {
  const spans = [];
  const stash = (match) => {
    spans.push(match);
    return `${P0}${spans.length - 1}${P1}`;
  };
  const masked = text.replace(CODE_RE, stash).replace(URL_RE, stash);
  return { masked, spans };
}

function restore(text, spans) {
  return text.replace(PLACEHOLDER_RE, (_, i) => spans[Number(i)]);
}

/** Strip sentinels a user might have pasted, so they can never leak into output. */
function sanitize(text) {
  let out = text;
  for (const s of SENTINELS) out = out.split(s).join('');
  return out;
}

function render(text, bold, italic, strike) {
  return text
    .split(B0).join(bold).split(B1).join(bold)
    .split(I0).join(italic).split(I1).join(italic)
    .split(S0).join(strike).split(S1).join(strike);
}

// --- Discord -> WhatsApp ---------------------------------------------------

/**
 * @param {string} text Discord message content
 * @param {object} [opts]
 * @param {(id: string) => string|undefined} [opts.resolveUser] Discord user id -> name
 * @param {(id: string) => string|undefined} [opts.resolveChannel]
 * @param {(id: string) => string|undefined} [opts.resolveRole]
 */
export function discordToWhatsApp(text, opts = {}) {
  if (!text) return '';
  const { masked, spans } = protect(sanitize(text));

  const out = masked
    // Mentions first, so the names they resolve to are not scanned for markup.
    .replace(/<@!?(\d+)>/g, (_, id) => `@${opts.resolveUser?.(id) ?? id}`)
    .replace(/<@&(\d+)>/g, (_, id) => `@${opts.resolveRole?.(id) ?? 'role'}`)
    .replace(/<#(\d+)>/g, (_, id) => `#${opts.resolveChannel?.(id) ?? 'channel'}`)
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    // Headings have no WhatsApp equivalent; bold is the closest.
    .replace(/^ {0,3}#{1,6}[ \t]+(.+)$/gm, `${B0}$1${B1}`)
    // Emphasis, longest markers first so `**` is never seen as two `*`.
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, `${B0}${I0}$1${I1}${B1}`)
    .replace(/\*\*([^*\n]+)\*\*/g, `${B0}$1${B1}`)
    .replace(/__([^_\n]+)__/g, `${I0}$1${I1}`) // underline -> italic (no WA equivalent)
    .replace(/\*([^*\n]+)\*/g, `${I0}$1${I1}`)
    .replace(/(?<![\w\\])_([^_\n]+)_(?!\w)/g, `${I0}$1${I1}`)
    .replace(/~~([^~\n]+)~~/g, `${S0}$1${S1}`)
    .replace(/\|\|([^|\n]+)\|\|/g, '$1'); // spoilers: markers dropped, text kept

  return restore(render(out, '*', '_', '~'), spans);
}

// --- WhatsApp -> Discord ---------------------------------------------------

/**
 * @param {string} text WhatsApp message body
 * @param {object} [opts]
 * @param {(number: string) => string|undefined} [opts.resolveMention] phone -> display name
 */
export function whatsAppToDiscord(text, opts = {}) {
  if (!text) return '';
  const { masked, spans } = protect(sanitize(text));

  let out = masked
    .replace(/\*([^*\n]+)\*/g, `${B0}$1${B1}`)
    .replace(/(?<![\w\\])_([^_\n]+)_(?!\w)/g, `${I0}$1${I1}`)
    .replace(/(?<!~)~([^~\n]+)~(?!~)/g, `${S0}$1${S1}`);

  if (opts.resolveMention) {
    out = out.replace(/@(\d{7,15})/g, (m, num) => {
      const name = opts.resolveMention(num);
      return name ? `@${name}` : m;
    });
  }

  return restore(render(out, '**', '*', '~~'), spans);
}

/** Discord blockquote used when a WhatsApp reply's target is not in Discord. */
export function quoteBlock(text, maxLen = 200) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const clipped = flat.length > maxLen ? `${flat.slice(0, maxLen)}…` : flat;
  return `> ${clipped}`;
}

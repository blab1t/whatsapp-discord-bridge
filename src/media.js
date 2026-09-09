import { config } from './config.js';
import { gifToMp4, mp4ToGif } from './convert.js';

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
};

const maxBytes = () => config.maxUploadMb * 1024 * 1024;

export function humanSize(bytes) {
  if (!bytes) return 'unknown size';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function fileNameFor(msg) {
  if (msg.fileName) return msg.fileName;
  const base = msg.mimetype?.split(';')[0];
  const ext = EXT_BY_MIME[base] || base?.split('/')[1] || 'bin';
  const prefix = msg.isVoiceNote ? 'voice-note' : msg.mediaType || 'file';
  return `${prefix}-${msg.waId?.slice(0, 8) || Date.now()}.${ext}`;
}

/**
 * Download WhatsApp media for Discord.
 * @returns {Promise<{file?: {buffer: Buffer, name: string}, notice?: string}>}
 */
export async function fromWhatsApp(wa, msg) {
  if (msg.fileLength && msg.fileLength > maxBytes()) {
    return {
      notice: `📎 *${msg.mediaType}* too large to relay (${humanSize(msg.fileLength)}, limit ${config.maxUploadMb} MB) — open WhatsApp to view.`,
    };
  }
  try {
    let buffer = await wa.downloadMedia(msg.raw);
    let name = fileNameFor(msg);

    // A WhatsApp "GIF" is a looping MP4. Turn small ones back into real GIFs
    // so Discord loops them inline; leave big ones as video, since a GIF of a
    // long clip is enormous.
    if (msg.gifPlayback && buffer.length <= 5 * 1024 * 1024) {
      const gif = await mp4ToGif(buffer);
      if (gif && gif.length <= maxBytes()) {
        buffer = gif;
        name = name.replace(/\.\w+$/, '.gif');
      }
    }

    if (buffer.length > maxBytes()) {
      return {
        notice: `📎 *${msg.mediaType}* too large to relay (${humanSize(buffer.length)}, limit ${config.maxUploadMb} MB) — open WhatsApp to view.`,
      };
    }
    return { file: { buffer, name } };
  } catch (err) {
    return { notice: `📎 Could not download ${msg.mediaType}: ${err.message}` };
  }
}

/**
 * Turn a Discord attachment into a Baileys send payload.
 * @param {{url: string, name: string, contentType: string|null, size: number}} attachment
 * @param {{caption?: string, voice?: boolean}} opts
 */
export async function toWhatsApp(attachment, opts = {}) {
  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const mime = (attachment.contentType || 'application/octet-stream').split(';')[0];
  const caption = opts.caption || undefined;

  if (opts.voice || (mime === 'audio/ogg' && attachment.name.endsWith('.ogg'))) {
    return { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true };
  }
  // GIFs must become MP4s, or WhatsApp shows a still frame.
  if (mime === 'image/gif') {
    const mp4 = await gifToMp4(buffer);
    if (mp4) return { video: mp4, caption, gifPlayback: true, mimetype: 'video/mp4' };
    return { document: buffer, mimetype: mime, fileName: attachment.name, caption };
  }
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') {
    return { image: buffer, caption, mimetype: mime };
  }
  if (mime.startsWith('video/')) {
    return { video: buffer, caption, mimetype: mime };
  }
  if (mime.startsWith('audio/')) {
    return { audio: buffer, mimetype: mime };
  }
  return { document: buffer, mimetype: mime, fileName: attachment.name, caption };
}

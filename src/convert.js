/**
 * Media transcoding between what Discord sends and what WhatsApp expects.
 *
 * The mismatch this module exists for:
 *   - A WhatsApp "GIF" is a looping MP4 with gifPlayback, never a real GIF.
 *   - A WhatsApp sticker is a 512x512 WebP, never a PNG.
 *   - A Discord GIF is usually a Tenor/Giphy link, not an attachment.
 *
 * ffmpeg is bundled (ffmpeg-static), but every function degrades to null
 * rather than throwing: a failed conversion should downgrade the message, not
 * lose it.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { logger } from './logger.js';

const run = promisify(execFile);
const FFMPEG_TIMEOUT_MS = 60_000;

// ffmpeg-static ships per-platform binaries; if none matches (some ARM builds)
// fall back to an ffmpeg on PATH, which is what `apt install ffmpeg` gives.
const FFMPEG = ffmpegPath || 'ffmpeg';

export const ffmpegAvailable = Boolean(FFMPEG);

/** Run ffmpeg over a buffer via temp files. Returns null on any failure. */
async function transcode(input, inExt, outExt, args) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-conv-'));
  const inFile = path.join(dir, `${randomUUID()}.${inExt}`);
  const outFile = path.join(dir, `${randomUUID()}.${outExt}`);
  try {
    writeFileSync(inFile, input);
    await run(FFMPEG, ['-y', '-loglevel', 'error', '-i', inFile, ...args, outFile], {
      timeout: FFMPEG_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return readFileSync(outFile);
  } catch (err) {
    logger.warn({ err: err.message, inExt, outExt }, 'ffmpeg conversion failed');
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** GIF -> MP4, which is what WhatsApp actually plays as a "GIF". */
export function gifToMp4(buffer) {
  return transcode(buffer, 'gif', 'mp4', [
    '-movflags', 'faststart',
    '-pix_fmt', 'yuv420p',
    // H.264 rejects odd dimensions, and plenty of GIFs have them.
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264',
    '-an',
  ]);
}

/** MP4 -> GIF, so a WhatsApp GIF loops in Discord instead of sitting as a video. */
export function mp4ToGif(buffer) {
  return transcode(buffer, 'mp4', 'gif', [
    '-vf',
    'fps=15,scale=320:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse',
    '-loop', '0',
  ]);
}

/**
 * Any image (PNG, APNG, GIF, WebP) -> a WhatsApp-shaped sticker: 512x512
 * WebP, transparent-padded so nothing is cropped.
 */
export function toSticker(buffer, inExt = 'png') {
  return transcode(buffer, inExt, 'webp', [
    '-vf',
    'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=#00000000',
    '-c:v', 'libwebp',
    '-loop', '0',
    '-q:v', '75',
    '-an',
    '-fps_mode', 'passthrough',
  ]);
}

// --- GIF links -------------------------------------------------------------

// Any Tenor/Giphy host (c.tenor.com, media1.giphy.com, ...) plus bare links
// to a .gif/.mp4 file anywhere.
const TENOR_OR_GIPHY =
  /https?:\/\/(?:[\w-]+\.)*(?:tenor\.com|giphy\.com|gfycat\.com)\/\S+|https?:\/\/\S+\.(?:gif|mp4)(?:\?\S*)?/gi;
const DIRECT_MEDIA = /\.(gif|mp4)(?:\?\S*)?$/i;

/** Every Tenor/Giphy or direct GIF link in a Discord message. */
export function findGifLinks(text) {
  return String(text || '').match(TENOR_OR_GIPHY) || [];
}

/** Is this message nothing but GIF links? Then the links ARE the message. */
export function isOnlyGifLinks(text) {
  const stripped = String(text || '').replace(TENOR_OR_GIPHY, '').trim();
  return stripped === '' && findGifLinks(text).length > 0;
}

/**
 * Resolve a share link to the underlying media file. Tenor and Giphy both put
 * it in Open Graph tags, so no API key is needed.
 * @returns {Promise<{url: string, kind: 'mp4'|'gif'}|null>}
 */
export async function resolveGifLink(link) {
  if (DIRECT_MEDIA.test(link)) {
    return { url: link, kind: link.toLowerCase().includes('.mp4') ? 'mp4' : 'gif' };
  }
  try {
    const res = await fetch(link, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; whatsapp-discord-bridge)' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const meta = (property) =>
      html.match(new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1] ??
      html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'))?.[1];

    const mp4 = meta('og:video:secure_url') || meta('og:video');
    if (mp4) return { url: mp4, kind: 'mp4' };
    const image = meta('og:image');
    if (image?.toLowerCase().includes('.gif')) return { url: image, kind: 'gif' };
    return null;
  } catch (err) {
    logger.warn({ err: err.message, link }, 'could not resolve gif link');
    return null;
  }
}

export async function download(url, maxBytes = 25 * 1024 * 1024) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const size = Number(res.headers.get('content-length') || 0);
  if (size > maxBytes) throw new Error(`file too large (${Math.round(size / 1024 / 1024)} MB)`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('file too large');
  return buffer;
}

/**
 * A GIF link, resolved and transcoded into a Baileys payload.
 * @returns {Promise<object|null>} `{video, gifPlayback}` or null
 */
export async function gifLinkToWhatsApp(link) {
  const resolved = await resolveGifLink(link);
  if (!resolved) {
    logger.warn({ link }, 'could not find the media behind this gif link');
    return null;
  }
  try {
    const buffer = await download(resolved.url);
    const mp4 = resolved.kind === 'mp4' ? buffer : await gifToMp4(buffer);
    if (!mp4) {
      logger.warn({ link, kind: resolved.kind }, 'gif transcode produced nothing');
      return null;
    }
    logger.info({ link, bytes: mp4.length }, 'relaying gif to WhatsApp');
    return { video: mp4, gifPlayback: true, mimetype: 'video/mp4' };
  } catch (err) {
    logger.warn({ err: err.message, link }, 'gif link relay failed');
    return null;
  }
}

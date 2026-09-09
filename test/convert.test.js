import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';

// convert.js pulls in the logger, which reads config at import time.
process.env.DISCORD_TOKEN ||= 'test';
process.env.DISCORD_CLIENT_ID ||= '1';
process.env.DISCORD_GUILD_ID ||= '2';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'wa-conv-cfg-'));
process.env.LOG_LEVEL = 'silent';
const { gifToMp4, mp4ToGif, toSticker, findGifLinks, isOnlyGifLinks } = await import(
  '../src/convert.js'
);

const run = promisify(execFile);

/** A real 2-second test-pattern GIF, so the transcodes run on actual media. */
async function sampleGif() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-conv-test-'));
  const file = path.join(dir, 'sample.gif');
  await run(ffmpegPath, [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=120x80:rate=10:duration=2',
    file,
  ]);
  const buffer = readFileSync(file);
  rmSync(dir, { recursive: true, force: true });
  return buffer;
}

const startsWith = (buffer, bytes) => buffer.subarray(0, bytes.length).equals(Buffer.from(bytes));

test('gif -> mp4 for WhatsApp gif playback', async () => {
  const mp4 = await gifToMp4(await sampleGif());
  assert.ok(mp4, 'conversion returned null');
  // ISO base media files carry 'ftyp' at byte 4.
  assert.equal(mp4.subarray(4, 8).toString(), 'ftyp');
});

test('mp4 -> gif for Discord', async () => {
  const mp4 = await gifToMp4(await sampleGif());
  const gif = await mp4ToGif(mp4);
  assert.ok(gif, 'conversion returned null');
  assert.ok(startsWith(gif, Buffer.from('GIF8')), 'not a GIF');
});

test('image -> 512x512 webp sticker', async () => {
  const webp = await toSticker(await sampleGif(), 'gif');
  assert.ok(webp, 'conversion returned null');
  assert.equal(webp.subarray(0, 4).toString(), 'RIFF');
  assert.equal(webp.subarray(8, 12).toString(), 'WEBP');
});

test('bad input degrades to null instead of throwing', async () => {
  assert.equal(await gifToMp4(Buffer.from('not a gif')), null);
});

test('gif links are detected', () => {
  assert.deepEqual(findGifLinks('look https://tenor.com/view/cat-dance-12345'), [
    'https://tenor.com/view/cat-dance-12345',
  ]);
  assert.equal(findGifLinks('no links here').length, 0);
  assert.ok(isOnlyGifLinks('  https://tenor.com/view/cat-12345  '));
  assert.ok(!isOnlyGifLinks('look at this https://tenor.com/view/cat-12345'));
});

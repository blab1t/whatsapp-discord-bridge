import test from 'node:test';
import assert from 'node:assert/strict';
import { discordToWhatsApp, whatsAppToDiscord } from '../src/format.js';

test('discord -> whatsapp: emphasis does not invert', () => {
  // The whole reason this module exists: `*x*` means bold in WhatsApp and
  // italic in Discord.
  assert.equal(discordToWhatsApp('**bold**'), '*bold*');
  assert.equal(discordToWhatsApp('*italic*'), '_italic_');
  assert.equal(discordToWhatsApp('_italic_'), '_italic_');
  assert.equal(discordToWhatsApp('***both***'), '*_both_*');
  assert.equal(discordToWhatsApp('~~gone~~'), '~gone~');
  assert.equal(discordToWhatsApp('__underline__'), '_underline_');
  assert.equal(discordToWhatsApp('||secret||'), 'secret');
});

test('whatsapp -> discord: emphasis does not invert', () => {
  assert.equal(whatsAppToDiscord('*bold*'), '**bold**');
  assert.equal(whatsAppToDiscord('_italic_'), '*italic*');
  assert.equal(whatsAppToDiscord('~gone~'), '~~gone~~');
  assert.equal(whatsAppToDiscord('*_both_*'), '***both***');
});

test('round trip is stable', () => {
  for (const original of [
    'plain text',
    '**bold** and *italic* and ~~strike~~',
    'a **b** c *d* e',
    'multi\nline **bold**',
  ]) {
    const there = discordToWhatsApp(original);
    assert.equal(whatsAppToDiscord(there), original, `round trip failed for: ${original}`);
  }
});

test('markup inside code spans is left alone', () => {
  assert.equal(discordToWhatsApp('`a**b**c`'), '`a**b**c`');
  assert.equal(whatsAppToDiscord('`a*b*c`'), '`a*b*c`');
  assert.equal(
    discordToWhatsApp('```js\nconst x = a ** b;\n```'),
    '```js\nconst x = a ** b;\n```',
  );
  assert.equal(discordToWhatsApp('text `code **x**` **real**'), 'text `code **x**` *real*');
});

test('urls are never treated as markup', () => {
  const url = 'https://example.com/a_b_c/d**e**';
  assert.equal(discordToWhatsApp(url), url);
  assert.equal(whatsAppToDiscord(url), url);
});

test('snake_case is not italicised', () => {
  assert.equal(discordToWhatsApp('some_var_name'), 'some_var_name');
  assert.equal(whatsAppToDiscord('some_var_name'), 'some_var_name');
});

test('headings become bold', () => {
  assert.equal(discordToWhatsApp('# Title'), '*Title*');
  assert.equal(discordToWhatsApp('### Small'), '*Small*');
  assert.equal(discordToWhatsApp('#hashtag'), '#hashtag');
});

test('quotes and lists pass through', () => {
  assert.equal(discordToWhatsApp('> quoted\n- one\n1. two'), '> quoted\n- one\n1. two');
});

test('mentions resolve', () => {
  const opts = {
    resolveUser: (id) => (id === '111' ? 'alex' : undefined),
    resolveChannel: () => 'general',
    resolveRole: () => 'admin',
  };
  assert.equal(discordToWhatsApp('hi <@111>', opts), 'hi @alex');
  assert.equal(discordToWhatsApp('hi <@999>', opts), 'hi @999');
  assert.equal(discordToWhatsApp('see <#5>', opts), 'see #general');
  assert.equal(discordToWhatsApp('<:party:12345>', opts), ':party:');
  assert.equal(
    whatsAppToDiscord('hi @491234567', { resolveMention: () => 'Anna' }),
    'hi @Anna',
  );
});

test('pasted sentinel characters cannot leak through', () => {
  const ctrl = (c) => String.fromCharCode(c);
  const pasted = `a${ctrl(0x11)}b${ctrl(0x17)}c${ctrl(0x18)}`;
  assert.equal(discordToWhatsApp(pasted), 'abc');
  assert.equal(whatsAppToDiscord(pasted), 'abc');
});

test('empty input is safe', () => {
  assert.equal(discordToWhatsApp(''), '');
  assert.equal(whatsAppToDiscord(undefined), '');
});

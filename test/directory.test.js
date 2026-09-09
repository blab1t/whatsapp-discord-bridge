import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// db.js reads config at import time, so the environment has to exist first and
// point at a throwaway database.
process.env.DISCORD_TOKEN = 'test';
process.env.DISCORD_CLIENT_ID = '1';
process.env.DISCORD_GUILD_ID = '2';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'wa-bridge-test-'));

const { contacts, chats, searchDirectory, lookupJid } = await import('../src/db.js');

contacts.upsertMany([
  { waJid: '491111111111@s.whatsapp.net', name: 'Anna Schmidt', isGroup: false },
  { waJid: '492222222222@s.whatsapp.net', name: 'Ben Meyer', isGroup: false },
  { waJid: '493333333333@s.whatsapp.net', name: '', isGroup: false },
  { waJid: '120363000000000000@g.us', name: 'Football Group', isGroup: true },
]);

chats.upsert({
  waJid: '492222222222@s.whatsapp.net',
  channelId: '900',
  webhookId: 'w',
  webhookToken: 't',
  name: 'Ben Meyer',
  isGroup: false,
});

test('finds contacts by name, case insensitively', () => {
  assert.deepEqual(
    searchDirectory('anna').map((r) => r.name),
    ['Anna Schmidt'],
  );
  assert.deepEqual(
    searchDirectory('MEYER').map((r) => r.name),
    ['Ben Meyer'],
  );
});

test('finds by partial phone number', () => {
  const hits = searchDirectory('1111');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].wa_jid, '491111111111@s.whatsapp.net');
});

test('finds groups', () => {
  const [group] = searchDirectory('football');
  assert.equal(group.is_group, 1);
});

test('already-bridged chats sort first', () => {
  // Ben is bridged; everyone else is not, so he leads an all-matching search.
  const all = searchDirectory('');
  assert.equal(all[0].wa_jid, '492222222222@s.whatsapp.net');
  assert.equal(all.length, 4);
});

test('a chat appears once, not once per source table', () => {
  const hits = searchDirectory('ben');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].channel_id, '900');
});

test('a later blank sync does not erase a known name', () => {
  contacts.upsertMany([{ waJid: '491111111111@s.whatsapp.net', name: '', isGroup: false }]);
  assert.equal(searchDirectory('anna')[0]?.name, 'Anna Schmidt');
});

test('no match returns nothing rather than everything', () => {
  assert.deepEqual(searchDirectory('zzzznotreal'), []);
});

test('a phone number never matches a group whose id contains those digits', () => {
  // Group jids are 120363<digits>@g.us, so a naive substring match on the jid
  // makes a group swallow a person's number — and once that group is bridged
  // it outranks the person forever.
  contacts.upsertMany([
    { waJid: '491234567890@s.whatsapp.net', name: 'Clara Weber', isGroup: false },
    { waJid: '120363491234567890@g.us', name: 'Some Group', isGroup: true },
  ]);
  chats.upsert({
    waJid: '120363491234567890@g.us',
    channelId: '901',
    webhookId: 'w',
    webhookToken: 't',
    name: 'Some Group',
    isGroup: true,
  });

  const hits = searchDirectory('491234567890');
  assert.equal(hits[0].wa_jid, '491234567890@s.whatsapp.net', 'the person must win');
  assert.ok(
    !hits.some((r) => r.is_group),
    'a number search must not return groups at all',
  );
});

test('partial numbers still match people by prefix', () => {
  const hits = searchDirectory('4912345');
  assert.ok(hits.some((r) => r.wa_jid === '491234567890@s.whatsapp.net'));
});

test('exact jid lookup does not borrow another row name', () => {
  assert.equal(lookupJid('491234567890@s.whatsapp.net')?.name, 'Clara Weber');
  assert.equal(lookupJid('120363491234567890@g.us')?.name, 'Some Group');
  assert.equal(lookupJid('999999999999@s.whatsapp.net'), undefined);
});

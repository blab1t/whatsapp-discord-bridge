import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, normalize, isLid } from '../src/jid.js';

const PN = '491234567890@s.whatsapp.net';
const LID = '189064561041642@lid';

test('device suffixes are stripped', () => {
  assert.equal(normalize('491234567890:12@s.whatsapp.net'), PN);
  assert.equal(normalize(PN), PN);
  assert.equal(normalize(undefined), undefined);
});

test('a LID chat resolves to the phone number when the key carries it', () => {
  const map = new Map();
  const out = canonical({ remoteJid: LID, senderPn: PN }, map);
  assert.equal(out.jid, PN, 'must be keyed by the phone number');
  assert.equal(out.alt, LID, 'the LID is reported so an old chat can be migrated');
  assert.equal(map.get(LID), PN, 'the mapping is learned');
});

test('a later message with only the LID still resolves', () => {
  // This is the whole point of the map: WhatsApp does not repeat senderPn on
  // every message, and without it the same person would get a second channel.
  const map = new Map();
  canonical({ remoteJid: LID, senderPn: PN }, map);
  const out = canonical({ remoteJid: LID }, map);
  assert.equal(out.jid, PN);
  assert.equal(out.alt, LID);
});

test('an unknown LID is left alone rather than guessed at', () => {
  const out = canonical({ remoteJid: LID }, new Map());
  assert.equal(out.jid, LID);
  assert.equal(out.alt, null, 'nothing to migrate when nothing was resolved');
});

test('plain phone chats are untouched', () => {
  const out = canonical({ remoteJid: PN }, new Map());
  assert.equal(out.jid, PN);
  assert.equal(out.alt, null);
  assert.equal(out.senderJid, PN);
});

test('group chats keep the group jid and resolve the participant', () => {
  const map = new Map();
  const out = canonical(
    {
      remoteJid: '120363000000000000@g.us',
      participant: LID,
      participantPn: PN,
    },
    map,
  );
  assert.equal(out.jid, '120363000000000000@g.us', 'the group is the chat');
  assert.equal(out.alt, null, 'groups are never remapped');
  assert.equal(out.senderJid, PN, 'the sender is the person, not their LID');
});

test('a participant LID learned in a group resolves in a later direct message', () => {
  const map = new Map();
  canonical({ remoteJid: '120363000000000000@g.us', participant: LID, participantPn: PN }, map);
  assert.equal(canonical({ remoteJid: LID }, map).jid, PN);
});

test('isLid only matches the lid server', () => {
  assert.ok(isLid(LID));
  assert.ok(!isLid(PN));
  assert.ok(!isLid('120363000000000000@g.us'));
});

/**
 * WhatsApp identity normalisation.
 *
 * WhatsApp addresses people two ways: the phone jid (`4915…@s.whatsapp.net`)
 * and a LID (`1890…@lid`), a stable hidden id used in places where the number
 * is not exposed. They are the SAME person. Treating them as different chats
 * gives you two Discord channels for one contact — one that fills with their
 * incoming messages, and another that `/chat` creates from your address book.
 *
 * Message keys carry the mapping (`senderPn`, `participantPn`), so the bridge
 * learns each LID's real number the first time that person messages, and every
 * chat is keyed by the phone jid from then on.
 *
 * Pure functions, no I/O.
 */

export const isLid = (jid) => typeof jid === 'string' && jid.endsWith('@lid');
export const isGroup = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');

/** Strip a device suffix and any `:NN` part: `4915:2@s.whatsapp.net` -> `4915@s.whatsapp.net`. */
export function normalize(jid) {
  if (typeof jid !== 'string' || !jid.includes('@')) return jid;
  const [user, server] = jid.split('@');
  return `${user.split(':')[0]}@${server}`;
}

/**
 * The canonical jid for a message, plus the LID it came in under (if any) so
 * callers can migrate an existing chat keyed by that LID.
 *
 * @param {object} key a Baileys message key
 * @param {Map<string,string>} [lidMap] learned LID -> phone jid, updated in place
 * @returns {{jid: string, alt: string|null, senderJid: string}}
 */
export function canonical(key, lidMap) {
  const remote = normalize(key?.remoteJid);
  const group = isGroup(remote);

  // Learn every mapping this key exposes, in both the chat and participant
  // positions, so later messages that omit it still resolve.
  const learn = (lid, pn) => {
    if (lidMap && isLid(normalize(lid)) && pn) lidMap.set(normalize(lid), normalize(pn));
  };
  learn(key?.remoteJid, key?.senderPn);
  learn(key?.senderLid, key?.senderPn);
  learn(key?.participant, key?.participantPn);
  learn(key?.participantLid, key?.participantPn);

  const resolve = (jid) => {
    const n = normalize(jid);
    if (!isLid(n)) return n;
    return lidMap?.get(n) ?? n;
  };

  const jid = group ? remote : resolve(key?.senderPn ?? key?.remoteJid);
  const alt = !group && isLid(remote) && jid !== remote ? remote : null;

  const participant = key?.participantPn ?? key?.participant;
  const senderJid = group ? resolve(participant) || jid : jid;

  return { jid, alt, senderJid };
}

/**
 * services/identityService.js — finding and creating contacts by identifier.
 *
 * Today a contact is matched by EMAIL only (the spec's unique key). A mobile
 * that arrives is stored as an extra identifier on the contact, never used
 * to match. When the rule later becomes "email + mobile", only findContact()
 * changes — the tables already support it (contact_identifiers is unique per
 * type+value, and contact_merges records merges).
 *
 * If a mobile already belongs to a different contact, it is NOT moved: the
 * conflict is returned so the caller can log it for review.
 */

const MATCH_ORDER = ["email"]; // later: ["email", "mobile"]

/** Locks and returns the contact for these identifiers, or null. */
async function findContact(conn, { email, mobile }) {
  const ids = { email, mobile };
  for (const type of MATCH_ORDER) {
    const value = ids[type];
    if (!value) continue;
    const [rows] = await conn.execute(
      `SELECT c.* FROM contact_identifiers ci JOIN contacts c ON c.id = ci.contact_id
       WHERE ci.type = ? AND ci.value = ? LIMIT 1 FOR UPDATE`,
      [type, value],
    );
    if (rows[0]) {
      // Follow a merge chain to the surviving record.
      let contact = rows[0];
      for (let hops = 0; contact.merged_into_id && hops < 5; hops += 1) {
        const [next] = await conn.execute("SELECT * FROM contacts WHERE id = ? FOR UPDATE", [contact.merged_into_id]);
        if (!next[0]) break;
        contact = next[0];
      }
      return { contact, matchedBy: type };
    }
  }
  return null;
}

/**
 * Adds an identifier to a contact. Returns
 *   { added: true } | { added: false, existing: true } (already this contact's)
 *   | { added: false, conflictContactId } (belongs to someone else)
 */
async function attachIdentifier(conn, contactId, { type, value, raw, source, primary = false }) {
  if (!value) return { added: false };
  const [rows] = await conn.execute("SELECT contact_id FROM contact_identifiers WHERE type = ? AND value = ? LIMIT 1", [
    type,
    value,
  ]);
  if (rows[0]) {
    if (rows[0].contact_id === contactId) return { added: false, existing: true };
    return { added: false, conflictContactId: rows[0].contact_id };
  }
  if (primary) {
    await conn.execute("UPDATE contact_identifiers SET is_primary = 0 WHERE contact_id = ? AND type = ?", [contactId, type]);
  }
  await conn.execute(
    `INSERT INTO contact_identifiers (contact_id, type, value, value_raw, is_primary, source)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [contactId, type, value, raw ? String(raw).slice(0, 320) : null, primary ? 1 : 0, source || null],
  );
  return { added: true };
}

/** Creates a contact with its primary email. Handles a parallel insert of the same email. */
async function createContact(conn, { email, emailRaw, stage, leadSource, source, createdAt }) {
  const [res] = await conn.execute(
    `INSERT INTO contacts (primary_email, stage, lead_source, created_at) VALUES (?, ?, ?, ?)`,
    [email, stage, leadSource, createdAt || new Date()],
  );
  const contactId = res.insertId;
  try {
    await attachIdentifier(conn, contactId, { type: "email", value: email, raw: emailRaw, source, primary: true });
  } catch (err) {
    if (err.code !== "ER_DUP_ENTRY") throw err;
    // Another request created this email a moment ago: drop ours, use theirs.
    await conn.execute("DELETE FROM contacts WHERE id = ?", [contactId]);
    return null;
  }
  const [rows] = await conn.execute("SELECT * FROM contacts WHERE id = ? FOR UPDATE", [contactId]);
  return rows[0];
}

module.exports = { findContact, attachIdentifier, createContact, MATCH_ORDER };

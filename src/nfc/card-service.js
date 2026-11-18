const { HttpError } = require('../http/errors');
const { normalizeCardUid } = require('./validation');

function findCardWithUser(db, cardUid) {
  return db
    .prepare(
      `
    SELECT c.card_uid, c.student_id, c.status AS card_status, u.status AS user_status
    FROM nfc_cards c
    JOIN users u ON u.student_id = c.student_id
    WHERE c.card_uid = ?
  `,
    )
    .get(cardUid);
}

function disableNfcCard(db, cardUid) {
  const normalized = normalizeCardUid(cardUid);
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `
    UPDATE nfc_cards
    SET status = 'disabled', disabled_at = ?, updated_at = ?
    WHERE card_uid = ? AND status = 'active'
  `,
    )
    .run(now, now, normalized);

  if (result.changes !== 1) {
    throw new HttpError(409, 'CARD_NOT_ACTIVE', '有効なカードが見つかりません');
  }
}

function replaceNfcCard(db, oldCardUid, newCardUid) {
  const oldUid = normalizeCardUid(oldCardUid);
  const newUid = normalizeCardUid(newCardUid);
  if (oldUid === newUid) {
    throw new HttpError(400, 'INVALID_REQUEST', '新旧カードUIDは異なる必要があります');
  }

  const replace = db.transaction(() => {
    const oldCard = db.prepare('SELECT * FROM nfc_cards WHERE card_uid = ?').get(oldUid);
    if (!oldCard || oldCard.status !== 'active') {
      throw new HttpError(409, 'CARD_NOT_ACTIVE', '交換元カードが有効ではありません');
    }

    if (db.prepare('SELECT 1 FROM nfc_cards WHERE card_uid = ?').get(newUid)) {
      throw new HttpError(409, 'CARD_ALREADY_REGISTERED', '新しいカードは登録済みです');
    }

    const now = new Date().toISOString();
    db.prepare(
      `
      UPDATE nfc_cards
      SET status = 'replaced', disabled_at = ?, updated_at = ?
      WHERE card_uid = ?
    `,
    ).run(now, now, oldUid);

    db.prepare(
      `
      INSERT INTO nfc_cards (
        card_uid, student_id, status, replaces_card_uid,
        issued_at, created_at, updated_at
      )
      VALUES (?, ?, 'active', ?, ?, ?, ?)
    `,
    ).run(newUid, oldCard.student_id, oldUid, now, now, now);
  });

  replace.immediate();
}

module.exports = { findCardWithUser, disableNfcCard, replaceNfcCard };

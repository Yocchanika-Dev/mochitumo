const { createDeviceKeyRecord } = require('../security/device-key');
const { normalizeCardUid } = require('../nfc/validation');

const { DEMO_DEVICE_ID, DEMO_DEVICE_KEY, DEMO_CARD_UID } = require('../development-defaults');

function seedDevelopmentData(
  db,
  { deviceKey = process.env.NFC_MOCK_DEVICE_KEY || DEMO_DEVICE_KEY } = {},
) {
  const now = new Date().toISOString();
  const keyRecord = createDeviceKeyRecord(deviceKey);
  const normalizedCardUid = normalizeCardUid(DEMO_CARD_UID);

  const seed = db.transaction(() => {
    const upsertUser = db.prepare(`
      INSERT INTO users (student_id, line_user_id, name, status, created_at, updated_at)
      VALUES (@studentId, @lineUserId, @name, 'active', @now, @now)
      ON CONFLICT(student_id) DO UPDATE SET
        line_user_id = excluded.line_user_id,
        name = excluded.name,
        status = 'active',
        updated_at = excluded.updated_at
    `);

    upsertUser.run({
      studentId: 'S1001',
      lineUserId: null,
      name: '借り手デモ',
      now,
    });

    db.prepare(
      `
      UPDATE devices
      SET status = 'disabled', updated_at = ?
      WHERE device_id = 'NFC_READER_01'
        AND name = '開発用NFC端末'
    `,
    ).run(now);
    upsertUser.run({
      studentId: 'S1002',
      lineUserId: 'U_DEMO_LENDER',
      name: '貸し手デモ',
      now,
    });

    db.prepare(
      `
      INSERT INTO devices (
        device_id, name, device_key_salt, device_key_hash, status,
        created_at, updated_at, key_rotated_at
      )
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        name = excluded.name,
        device_key_salt = excluded.device_key_salt,
        device_key_hash = excluded.device_key_hash,
        status = 'active',
        updated_at = excluded.updated_at,
        key_rotated_at = excluded.key_rotated_at
    `,
    ).run(DEMO_DEVICE_ID, '開発用NFC端末', keyRecord.saltHex, keyRecord.hashHex, now, now, now);

    db.prepare(
      `
      UPDATE nfc_cards
      SET status = 'disabled', disabled_at = ?, updated_at = ?
      WHERE student_id = 'S1001'
        AND status = 'active'
        AND card_uid <> ?
    `,
    ).run(now, now, normalizedCardUid);

    db.prepare(
      `
      INSERT INTO nfc_cards (
        card_uid, student_id, status, issued_at, created_at, updated_at
      )
      VALUES (?, 'S1001', 'active', ?, ?, ?)
      ON CONFLICT(card_uid) DO UPDATE SET
        student_id = 'S1001',
        status = 'active',
        replaces_card_uid = NULL,
        disabled_at = NULL,
        updated_at = excluded.updated_at
    `,
    ).run(normalizedCardUid, now, now, now);

    db.prepare(
      `
      INSERT INTO bikes (
        bike_id, owner_student_id, availability, created_at, updated_at
      )
      VALUES ('B003', 'S1002', 'available', ?, ?)
      ON CONFLICT(bike_id) DO UPDATE SET
        owner_student_id = 'S1002',
        updated_at = excluded.updated_at
    `,
    ).run(now, now);
  });

  seed.immediate();

  return {
    deviceId: DEMO_DEVICE_ID,
    cardUid: normalizedCardUid,
  };
}

module.exports = {
  DEMO_CARD_UID,
  DEMO_DEVICE_ID,
  DEMO_DEVICE_KEY,
  seedDevelopmentData,
};

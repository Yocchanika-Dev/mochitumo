const { HttpError } = require('../http/errors');
const { validateLockTapBody } = require('../nfc/validation');
const { findCardWithUser } = require('../nfc/card-service');
const { operation } = require('./operations');
const { createLockCommand } = require('./commands');
const { getRequest, publicRequest } = require('./queries');
const { log } = require('../db/events');

function deny(status, code, message) {
  throw new HttpError(status, code, message);
}

function unlockAtReader(db, { source, resolveBike, body }) {
  const input = validateLockTapBody(body);
  let created = false;
  // 対応機器・カード状態の確認と命令発行は同一の書込トランザクションで行う。
  const response = db
    .transaction(() => {
      const bike = resolveBike();
      if (!bike) deny(403, 'LOCK_READER_NOT_REGISTERED', '許可されたロックリーダーではありません');
      const card = findCardWithUser(db, input.cardUid);
      if (!card) deny(404, 'CARD_NOT_REGISTERED', '登録されていないカードです');
      if (card.card_status !== 'active' || card.user_status !== 'active') {
        deny(403, 'CARD_DISABLED', 'このカードは利用できません');
      }
      return operation(
        db,
        source,
        input.clientRequestId,
        {
          action: 'unlock',
          card_uid: input.cardUid,
          bike_id: bike.bike_id,
        },
        () => {
          const request = db
            .prepare(
              `
        SELECT * FROM rental_requests WHERE bike_id=? AND status='approved'
      `,
            )
            .get(bike.bike_id);
          if (!request)
            deny(409, 'NO_APPROVED_RENTAL', 'この自転車に解錠待ちの承認済み申請がありません');
          if (request.borrower_student_id !== card.student_id) {
            deny(403, 'NOT_APPROVED_BORROWER', 'この自転車の承認済み借り手ではありません');
          }
          if (bike.availability !== 'reserved')
            deny(409, 'BIKE_NOT_RESERVED', '自転車は解錠待ち状態ではありません');
          let command = db
            .prepare("SELECT * FROM lock_commands WHERE request_id=? AND action='unlock'")
            .get(request.request_id);
          if (command && ['failed', 'timed_out', 'succeeded'].includes(command.status)) {
            deny(409, 'UNLOCK_RETRY_REQUIRED', '既存の解錠結果を確認してから復旧してください');
          }
          if (!command) {
            command = createLockCommand(db, {
              requestId: request.request_id,
              bikeId: bike.bike_id,
              action: 'unlock',
            });
            created = true;
          }
          // 別のタッチ操作でも進行中commandを共用し、サーボの重複実行を避ける。
          db.prepare(
            `INSERT OR IGNORE INTO unlock_authorizations
        (command_id,borrower_student_id,reader_source,client_request_id,created_at)
        VALUES (?,?,?,?,?)`,
          ).run(
            command.command_id,
            card.student_id,
            source,
            input.clientRequestId,
            new Date().toISOString(),
          );
          log(db, 'unlock.authorized', request.request_id, source, {
            command_id: command.command_id,
          });
          return {
            request: publicRequest(getRequest(db, request.request_id)),
            lock_command: {
              command_id: command.command_id,
              action: 'unlock',
              status: command.status,
            },
          };
        },
      );
    })
    .immediate();
  return { created, response };
}

function unlockForHttpReader(db, { deviceId, body }) {
  return unlockAtReader(db, {
    source: `lock-http:${deviceId}`,
    body,
    resolveBike: () =>
      db
        .prepare(
          `
      SELECT b.* FROM lock_readers lr
      JOIN devices d ON d.device_id=lr.device_id AND d.status='active'
      JOIN bikes b ON b.bike_id=lr.bike_id WHERE lr.device_id=?
    `,
        )
        .get(deviceId),
  });
}

function unlockForSerialReader(db, { relayId, deviceId, bikeId, body }) {
  return unlockAtReader(db, {
    source: `lock-serial:${relayId}:${deviceId}`,
    body,
    resolveBike: () => {
      if (typeof relayId !== 'string' || typeof deviceId !== 'string') return;
      const bike = db
        .prepare('SELECT * FROM bikes WHERE device_id=? AND relay_id=?')
        .get(deviceId, relayId);
      if (bikeId !== undefined && bikeId !== bike?.bike_id) return;
      return bike;
    },
  });
}

module.exports = { unlockForHttpReader, unlockForSerialReader };

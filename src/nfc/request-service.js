const crypto = require('crypto');
const { HttpError } = require('../http/errors');
const { log } = require('../db/events');
const { findCardWithUser } = require('./card-service');

function requestFingerprint({ action, cardUid }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ action, card_uid: cardUid }))
    .digest('hex');
}

function successResponse(requestId, studentId, status = 'requesting') {
  return {
    success: true,
    request_id: requestId,
    student_id: studentId,
    status,
  };
}

function createNfcRentalRequest(db, input) {
  const fingerprint = requestFingerprint(input);

  const createInTransaction = db.transaction(() => {
    // 冪等再送はカード失効や貸出状態の変化より先に、初回結果を返す。
    const idempotencyRecord = db
      .prepare(
        `
      SELECT *
      FROM idempotency_records
      WHERE device_id = ? AND client_request_id = ?
    `,
      )
      .get(input.deviceId, input.clientRequestId);

    if (idempotencyRecord) {
      if (idempotencyRecord.request_fingerprint !== fingerprint) {
        throw new HttpError(
          409,
          'IDEMPOTENCY_CONFLICT',
          '同じ操作IDで異なる申請内容が送信されました',
        );
      }

      return {
        created: false,
        response: successResponse(
          idempotencyRecord.request_id,
          idempotencyRecord.response_student_id,
          idempotencyRecord.response_status,
        ),
      };
    }

    const card = findCardWithUser(db, input.cardUid);

    if (!card) {
      throw new HttpError(404, 'CARD_NOT_REGISTERED', '登録されていないカードです');
    }
    if (card.card_status !== 'active' || card.user_status !== 'active') {
      throw new HttpError(403, 'CARD_DISABLED', 'このカードは利用できません');
    }

    const activeRequest = db
      .prepare(
        `
      SELECT request_id, status
      FROM rental_requests
      WHERE borrower_student_id = ?
        AND status IN ('requesting', 'approved', 'rented')
    `,
      )
      .get(card.student_id);

    if (activeRequest) {
      throw new HttpError(409, 'ACTIVE_REQUEST_EXISTS', '未完了の貸出申請が存在します', {
        existing_request_id: activeRequest.request_id,
        existing_status: activeRequest.status,
      });
    }

    const now = new Date().toISOString();
    const requestId = `req_${crypto.randomUUID()}`;

    db.prepare(
      `
      INSERT INTO rental_requests (
        request_id, borrower_student_id, status, source_device_id,
        client_request_id, request_fingerprint, created_at, updated_at
      )
      VALUES (?, ?, 'requesting', ?, ?, ?, ?, ?)
    `,
    ).run(requestId, card.student_id, input.deviceId, input.clientRequestId, fingerprint, now, now);

    db.prepare(
      `
      INSERT INTO idempotency_records (
        device_id, client_request_id, request_fingerprint, request_id,
        response_student_id, response_status, created_at
      )
      VALUES (?, ?, ?, ?, ?, 'requesting', ?)
    `,
    ).run(input.deviceId, input.clientRequestId, fingerprint, requestId, card.student_id, now);

    db.prepare(
      `
      INSERT INTO inbound_events (
        source, source_id, event_id, body_hash, received_at
      )
      VALUES ('nfc', ?, ?, ?, ?)
    `,
    ).run(input.deviceId, input.clientRequestId, fingerprint, now);

    log(
      db,
      'request.created',
      requestId,
      input.deviceId,
      { client_request_id: input.clientRequestId },
      'nfc',
      now,
    );

    return {
      created: true,
      response: successResponse(requestId, card.student_id),
    };
  });

  return createInTransaction.immediate();
}

module.exports = { createNfcRentalRequest };

const { HttpError } = require('../http/errors');
const { getRequest, publicRequest } = require('./queries');
const { createLockCommand } = require('./commands');
const { log } = require('../db/events');
const { findCardWithUser } = require('../nfc/card-service');
const { operation } = require('./operations');
const { validateConfirmationId } = require('../http/validation');

function fail(status, code, message) {
  throw new HttpError(status, code, message);
}
function cancel(db, { id, studentId, eventId, source }) {
  return operation(db, source, eventId, { id, studentId, action: 'cancel' }, () => {
    const r = getRequest(db, id);
    if (r.borrower_student_id !== studentId) fail(404, 'REQUEST_NOT_FOUND', '申請が見つかりません');
    if (r.status !== 'requesting') fail(409, 'INVALID_STATE', '募集中の申請だけ取消できます');
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE rental_requests SET status='cancelled',cancelled_at=?,updated_at=? WHERE request_id=? AND status='requesting'",
    ).run(now, now, id);
    log(db, 'request.cancelled', id, studentId);
    return { request_id: id, status: 'cancelled', updated_at: now };
  });
}
function approve(db, { id, studentId, bikeId, eventId, confirmationId }) {
  // 未指定の旧イベントは従来と同じキー順・JSONでfingerprintを作る。
  // 既存receiptを新形式へ読み替えたり、ID差異を無視するfallbackは行わない。
  const identity = { id, studentId, bikeId, action: 'approve' };
  if (confirmationId !== undefined)
    identity.confirmationId = validateConfirmationId(confirmationId);
  return operation(db, 'line', eventId, identity, () => {
    const r = getRequest(db, id);
    if (r.status !== 'requesting') fail(409, 'INVALID_STATE', '募集中の申請だけ承認できます');
    if (r.borrower_student_id === studentId)
      fail(403, 'SELF_APPROVAL', '自分の申請は承認できません');
    const bike = db.prepare('SELECT * FROM bikes WHERE bike_id=?').get(bikeId);
    if (!bike) fail(404, 'BIKE_NOT_FOUND', '自転車が見つかりません');
    if (bike.owner_student_id !== studentId)
      fail(403, 'BIKE_NOT_OWNED', '所有する自転車だけ承認できます');
    if (bike.availability !== 'available')
      fail(409, 'BIKE_NOT_AVAILABLE', '自転車は利用できません');
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE bikes SET availability='reserved',updated_at=? WHERE bike_id=? AND availability='available'",
    ).run(now, bikeId);
    db.prepare(
      "UPDATE rental_requests SET status='approved',lender_student_id=?,bike_id=?,approved_at=?,updated_at=? WHERE request_id=? AND status='requesting'",
    ).run(studentId, bikeId, now, now, id);
    log(db, 'request.approved', id, studentId);
    return {
      request: publicRequest(getRequest(db, id)),
      lock_command: null,
      next_action: 'tap_card',
    };
  });
}
function cardStudent(db, uid) {
  const row = findCardWithUser(db, uid);
  if (!row || row.card_status !== 'active' || row.user_status !== 'active') {
    fail(403, 'CARD_DISABLED', '有効なカードが必要です');
  }
  return row.student_id;
}
function requestLock(db, { id, studentId, eventId }) {
  return operation(db, 'line', eventId, { id, studentId, action: 'lock' }, () => {
    const r = getRequest(db, id);
    if (r.borrower_student_id !== studentId) fail(404, 'REQUEST_NOT_FOUND', '申請が見つかりません');
    if (r.status !== 'rented') fail(409, 'INVALID_STATE', '貸出中の申請だけ返却できます');
    const old = db
      .prepare("SELECT command_id FROM lock_commands WHERE request_id=? AND action='lock'")
      .get(id);
    if (old) fail(409, 'LOCK_ALREADY_REQUESTED', '施錠命令は発行済みです');
    return createLockCommand(db, { requestId: id, bikeId: r.bike_id, action: 'lock' });
  });
}
module.exports = { getRequest, publicRequest, cancel, approve, cardStudent, log, requestLock };

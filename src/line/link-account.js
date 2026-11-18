// 管理者が別途本人確認した既存学生だけを紐付ける。公開の本人確認APIではない。
function linkBorrowerAccount(db, input) {
  const allowed = ['student_id', 'line_user_id', 'verified_by_operator'];
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    typeof input.student_id !== 'string' ||
    !input.student_id.trim() ||
    input.student_id !== input.student_id.trim() ||
    input.student_id.length > 128 ||
    typeof input.line_user_id !== 'string' ||
    !/^U[0-9a-f]{32}$/i.test(input.line_user_id) ||
    input.verified_by_operator !== true
  )
    throw new Error('Invalid verified account input');
  return db
    .transaction(() => {
      const user = db
        .prepare('SELECT status,line_user_id FROM users WHERE student_id=?')
        .get(input.student_id);
      if (!user || user.status !== 'active') throw new Error('Existing active student required');
      const collision = db
        .prepare('SELECT student_id FROM users WHERE line_user_id=? AND student_id<>?')
        .get(input.line_user_id, input.student_id);
      if (collision || (user.line_user_id && user.line_user_id !== input.line_user_id))
        throw new Error('Existing identity must not be overwritten');
      if (user.line_user_id !== input.line_user_id) {
        db.prepare('UPDATE users SET line_user_id=?,updated_at=? WHERE student_id=?').run(
          input.line_user_id,
          new Date().toISOString(),
          input.student_id,
        );
      }
      return { student_id: input.student_id, linked: true };
    })
    .immediate();
}
module.exports = { linkBorrowerAccount };

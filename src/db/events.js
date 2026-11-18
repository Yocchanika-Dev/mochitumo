function log(
  db,
  type,
  requestId,
  actor,
  payload = {},
  actorType = 'integration',
  createdAt = new Date().toISOString(),
) {
  return db
    .prepare(
      `
    INSERT INTO event_logs (
      event_type, entity_type, entity_id, actor_type, actor_id,
      payload_json, created_at
    ) VALUES (?, 'request', ?, ?, ?, ?, ?)
  `,
    )
    .run(type, requestId, actorType, actor, JSON.stringify(payload), createdAt);
}

module.exports = { log };

const crypto = require('crypto');

function createLockCommand(
  db,
  { requestId, bikeId, action, createdAt = new Date().toISOString() },
) {
  const commandId = `cmd_${crypto.randomUUID()}`;
  db.prepare(
    `
    INSERT INTO lock_commands (command_id, request_id, bike_id, action, status, created_at)
    VALUES (?, ?, ?, ?, 'queued', ?)
  `,
  ).run(commandId, requestId, bikeId, action, createdAt);
  return { command_id: commandId, action, status: 'queued' };
}

module.exports = { createLockCommand };

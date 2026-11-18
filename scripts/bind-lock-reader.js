const { openDatabase } = require('../src/db/database');
require('../src/config').loadEnvironmentFile();

const [deviceId, bikeId] = process.argv.slice(2);
if (!deviceId || !bikeId) {
  console.error('Usage: npm run lock-reader:bind -- <registered-device-id> <bike-id>');
  process.exitCode = 1;
} else {
  const db = openDatabase();
  try {
    db.transaction(() => {
      if (
        !db.prepare("SELECT 1 FROM devices WHERE device_id=? AND status='active'").get(deviceId)
      ) {
        throw new Error('有効な登録済み端末IDを指定してください');
      }
      if (!db.prepare('SELECT 1 FROM bikes WHERE bike_id=?').get(bikeId)) {
        throw new Error('登録済み自転車IDを指定してください');
      }
      const old = db
        .prepare('SELECT * FROM lock_readers WHERE device_id=? OR bike_id=?')
        .all(deviceId, bikeId);
      if (old.length) {
        if (old.length === 1 && old[0].device_id === deviceId && old[0].bike_id === bikeId) return;
        throw new Error('既存の端末・自転車対応は上書きしません');
      }
      db.prepare('INSERT INTO lock_readers(device_id,bike_id,created_at) VALUES (?,?,?)').run(
        deviceId,
        bikeId,
        new Date().toISOString(),
      );
    }).immediate();
    console.log(`Lock reader bound: ${deviceId} -> ${bikeId}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

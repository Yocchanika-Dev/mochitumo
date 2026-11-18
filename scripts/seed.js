const { openDatabase } = require('../src/db/database');
const { seedDevelopmentData } = require('../src/db/seed');
require('../src/config').loadEnvironmentFile();

if (process.env.NODE_ENV === 'production') {
  throw new Error('Development seed cannot run in production');
}

const db = openDatabase();
try {
  const seeded = seedDevelopmentData(db);
  console.log(`Development data seeded for device: ${seeded.deviceId}`);
  console.log(`Development card registered: ${seeded.cardUid}`);
} finally {
  db.close();
}

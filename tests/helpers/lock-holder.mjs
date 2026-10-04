import { DatabaseSync } from 'node:sqlite';
const database = new DatabaseSync(process.argv[2]);
process.send({ type: 'ready' });
process.on('message', message => {
  if (message.type !== 'lock') return;
  database.exec('BEGIN IMMEDIATE');
  process.send({ type: 'locked' });
  setTimeout(() => {
    database.exec('COMMIT');
    database.close();
    process.disconnect();
  }, message.holdMs);
});

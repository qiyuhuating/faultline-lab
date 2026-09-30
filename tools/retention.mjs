import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from '../src/queue.mjs';

const database = process.argv.find(a => a.startsWith('--db='))?.slice(5) ?? fileURLToPath(new URL('../data/faultline.sqlite', import.meta.url));
const queue = new Queue(resolve(database));
try {
  const results = [];
  let result;
  do {
    result = queue.prune();
    results.push(result);
  } while (result.removedJobs === 500 || result.removedEvents === 5000);
  console.log(JSON.stringify({ policy: '30 days / 50,000 recent events; active jobs preserved', passes: results, integrity: queue.evidence().integrity }, null, 2));
} finally { queue.close(); }

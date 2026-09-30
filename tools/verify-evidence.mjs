import { readFileSync } from 'node:fs';
import { canonical, digest } from '../src/validation.mjs';

const path = process.argv[2];
if (!path) throw new Error('Usage: node tools/verify-evidence.mjs faultline-evidence.json');
const evidence = JSON.parse(readFileSync(path, 'utf8'));
if (evidence.format !== 'faultline-evidence-v1' || !Array.isArray(evidence.events)) throw new Error('Unsupported evidence format.');
let previous = evidence.integrity.anchor;
let seq = null;
for (const event of evidence.events) {
  const hash = digest(canonical({ seq: event.seq, jobId: event.jobId, type: event.type, at: event.at, data: event.data, previousHash: event.previousHash }));
  if (hash !== event.hash || event.previousHash !== previous || (seq !== null && event.seq !== seq + 1)) throw new Error(`Chain mismatch at #${event.seq}.`);
  previous = hash;
  seq = event.seq;
}
if (previous !== evidence.integrity.head || evidence.events.length !== evidence.integrity.count || evidence.integrity.valid !== true) throw new Error('Head or count mismatch.');
console.log(`Verified ${evidence.events.length} retained events. This is a consistency check, not third-party authenticity proof.`);

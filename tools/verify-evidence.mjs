import { readFileSync } from 'node:fs';
import { digest } from '../src/validation.mjs';
import { verifyEvidence } from '../public/evidence.mjs';

const path = process.argv[2];
if (!path) throw new Error('Usage: node tools/verify-evidence.mjs faultline-evidence.json');
const evidence = JSON.parse(readFileSync(path, 'utf8'));
await verifyEvidence(evidence, digest);
console.log(`Verified ${evidence.events.length} retained events. This is a consistency check, not third-party authenticity proof.`);

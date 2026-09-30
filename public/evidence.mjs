export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export async function verifyEvidence(evidence, hash) {
  if (evidence?.format !== 'faultline-evidence-v1' || !Array.isArray(evidence.events) || evidence.events.length > 60000 || !evidence.integrity || typeof evidence.integrity.anchor !== 'string') throw new Error('Unsupported or incomplete evidence.');
  let previous = evidence.integrity.anchor;
  let sequence = null;
  for (const event of evidence.events) {
    if (!Number.isSafeInteger(event.seq) || !Number.isSafeInteger(event.at) || typeof event.type !== 'string' || typeof event.hash !== 'string' || !event.data || typeof event.data !== 'object') throw new Error('Malformed event.');
    const computed = await hash(canonical({ seq: event.seq, jobId: event.jobId, type: event.type, at: event.at, data: event.data, previousHash: event.previousHash }));
    if (computed !== event.hash || event.previousHash !== previous || (sequence !== null && event.seq !== sequence + 1)) throw new Error(`Chain mismatch at #${event.seq}.`);
    previous = event.hash;
    sequence = event.seq;
  }
  if (previous !== evidence.integrity.head || evidence.events.length !== evidence.integrity.count || evidence.integrity.valid !== true) throw new Error('Head or count mismatch.');
  return { valid: true, count: evidence.events.length, head: previous };
}

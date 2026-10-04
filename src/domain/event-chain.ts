import type { Event } from './types.ts';
import { canonical, digest } from '../validation.ts';

export interface ChainIntegrity {
  valid: boolean;
  count: number;
  anchor: string;
  head: string;
  range: {
    anchorSequence: number | null;
    headSequence: number;
    source: 'stored' | 'genesis' | 'legacy-inferred' | 'unknown';
  };
}
// Streaming inspection bounds memory independently of the retained event count.
export function inspectChain(
  events: Iterable<Event>,
  anchor: string,
  storedAnchorSequence: number | undefined,
  headSequence: number,
): ChainIntegrity {
  let anchorSequence: number | null = storedAnchorSequence ?? (anchor === 'GENESIS' ? 0 : null);
  let source: ChainIntegrity['range']['source'] =
    storedAnchorSequence !== undefined ? 'stored' : anchor === 'GENESIS' ? 'genesis' : 'unknown';
  let previousHash = anchor;
  let sequence = anchorSequence;
  let count = 0;
  let valid =
    Number.isSafeInteger(headSequence) &&
    headSequence >= 0 &&
    (anchorSequence === null ||
      (Number.isSafeInteger(anchorSequence) &&
        anchorSequence >= 0 &&
        anchorSequence <= headSequence));
  for (const event of events) {
    if (sequence === null) {
      anchorSequence = event.seq - 1;
      sequence = anchorSequence;
      source = 'legacy-inferred';
    }
    const expected = digest(
      canonical({
        seq: event.seq,
        jobId: event.jobId,
        type: event.type,
        at: event.at,
        data: event.data,
        previousHash: event.previousHash,
      }),
    );
    if (
      !Number.isSafeInteger(event.seq) ||
      !Number.isSafeInteger(event.at) ||
      event.seq !== sequence + 1 ||
      event.previousHash !== previousHash ||
      event.hash !== expected
    )
      valid = false;
    previousHash = event.hash;
    sequence = event.seq;
    count++;
  }
  // Empty is valid only when the exact retained-prefix boundary reaches the head.
  // An unknown legacy empty prefix cannot prove that the entire tail survived.
  if (
    anchorSequence === null ||
    sequence !== headSequence ||
    count !== headSequence - anchorSequence
  )
    valid = false;
  return {
    valid,
    count,
    anchor,
    head: previousHash,
    range: { anchorSequence, headSequence, source },
  };
}

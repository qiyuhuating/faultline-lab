import type { JobKind, JsonObject } from './domain/types.ts';
import { digest, DomainError } from './validation.ts';

export function execute(kind: JobKind, text: string): JsonObject {
  if (kind === 'digest') {
    const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
    return {
      sha256: digest(text),
      bytes: Buffer.byteLength(text),
      characters: [...text].length,
      words,
    };
  }
  if (kind === 'csv_summary') {
    // Deliberately a restricted numeric series format, not a pretend CSV parser.
    const tokens = text
      .trim()
      .split(/[\s,;]+/u)
      .filter(Boolean);
    if (!tokens.length || tokens.length > 2000)
      throw new DomainError('INPUT_INVALID', '输入需包含 1–2,000 个数值。');
    const values = tokens.map(Number);
    if (values.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e12))
      throw new DomainError('INPUT_INVALID', '输入只能包含有限数值（绝对值不超过 10¹²）。');
    const sum = values.reduce((a, b) => a + b, 0);
    return {
      count: values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      sum,
      mean: sum / values.length,
      sha256: digest(text),
    };
  }
  throw new DomainError('HANDLER_UNKNOWN', '没有可用的处理器。');
}

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
    // Every binary64 input is an integer multiple of 2^-1074. Accumulate exactly,
    // then round once to nearest, ties to even; input order cannot lose residuals.
    const view = new DataView(new ArrayBuffer(8));
    let total = 0n;
    for (const value of values) {
      view.setFloat64(0, value);
      const bits = view.getBigUint64(0);
      const exponent = Number((bits >> 52n) & 0x7ffn);
      let coefficient = bits & ((1n << 52n) - 1n);
      if (exponent !== 0) coefficient = (coefficient | (1n << 52n)) << BigInt(exponent - 1);
      total += value < 0 ? -coefficient : coefficient;
    }
    const negative = total < 0n;
    const magnitude = negative ? -total : total;
    const shift = Math.max(0, magnitude.toString(2).length - 53);
    let rounded = magnitude >> BigInt(shift);
    if (shift > 0) {
      const remainder = magnitude - (rounded << BigInt(shift));
      const halfway = 1n << BigInt(shift - 1);
      if (remainder > halfway || (remainder === halfway && (rounded & 1n) !== 0n)) rounded++;
    }
    const sum = (negative ? -1 : 1) * Number(rounded) * 2 ** (shift - 1074);
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

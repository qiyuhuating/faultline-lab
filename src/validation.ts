import { SCENARIO_NAMES } from './domain/types.ts';
import type { JobDefinition, Json } from './domain/types.ts';
import { createHash } from 'node:crypto';

export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function insist(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new DomainError(code, message, status);
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Value is not JSON serializable.');
  return encoded;
}

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function object(
  value: unknown,
  fields: readonly string[],
): asserts value is Record<string, unknown> {
  insist(
    value && typeof value === 'object' && !Array.isArray(value),
    'VALIDATION',
    '请求必须是 JSON 对象。',
  );
  insist(
    Object.keys(value).every((k) => fields.includes(k)),
    'VALIDATION',
    '请求含有不支持的字段。',
  );
}

export function integer(value: unknown, min: number, max: number, name: string): number {
  insist(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max,
    'VALIDATION',
    `${name} 必须是 ${min}–${max} 的整数。`,
  );
  return value;
}

export function revision(value: unknown) {
  return integer(value, 1, Number.MAX_SAFE_INTEGER, 'expectedRevision');
}

export function key(value: unknown) {
  insist(
    typeof value === 'string' && /^[\w.:\-]{8,128}$/.test(value),
    'IDEMPOTENCY_REQUIRED',
    '写入需要 8–128 字符的 Idempotency-Key。',
  );
  return value;
}

export function jobDefinition(input: unknown): JobDefinition {
  object(input, [
    'kind',
    'label',
    'text',
    'priority',
    'maxAttempts',
    'delayMs',
    'scheduleMs',
    'fault',
  ]);
  const kind = input.kind ?? 'digest';
  insist(kind === 'digest' || kind === 'csv_summary', 'VALIDATION', '任务类型不受支持。');
  const label = input.label ?? 'Untitled task';
  insist(
    typeof label === 'string' && label.trim().length >= 1 && label.trim().length <= 80,
    'VALIDATION',
    '任务名称需为 1–80 字符。',
  );
  const text = input.text ?? 'Reliable systems leave evidence.';
  insist(
    typeof text === 'string' && Buffer.byteLength(text) <= 12000,
    'VALIDATION',
    '任务输入不可超过 12 KB。',
  );
  const fault = input.fault ?? {};
  object(fault, ['failFirst', 'crashOnce', 'stallOnce']);
  insist(
    fault.crashOnce === undefined || typeof fault.crashOnce === 'boolean',
    'VALIDATION',
    'crashOnce 必须是布尔值。',
  );
  insist(
    fault.stallOnce === undefined || typeof fault.stallOnce === 'boolean',
    'VALIDATION',
    'stallOnce 必须是布尔值。',
  );
  return {
    kind,
    label: label.trim(),
    text,
    priority: integer(input.priority ?? 0, 0, 5, 'priority'),
    maxAttempts: integer(input.maxAttempts ?? 4, 1, 5, 'maxAttempts'),
    delayMs: integer(input.delayMs ?? 550, 0, 8000, 'delayMs'),
    scheduleMs: integer(input.scheduleMs ?? 0, 0, 60000, 'scheduleMs'),
    fault: {
      failFirst: integer(fault.failFirst ?? 0, 0, 10, 'failFirst'),
      crashOnce: fault.crashOnce ?? false,
      stallOnce: fault.stallOnce ?? false,
    },
  };
}

// JSON parsing is an untrusted boundary. No `any` is allowed past it.
export function parseJSON(text: string): unknown {
  return JSON.parse(text) as unknown;
}
export function jsonValue(value: unknown): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonValue(v)]));
  throw new TypeError('Value is not JSON serializable.');
}
export function jsonObject(value: unknown): import('./domain/types.ts').JsonObject {
  object(value, Object.keys(value && typeof value === 'object' ? value : {}));
  const checked = jsonValue(value);
  if (checked === null || typeof checked !== 'object' || Array.isArray(checked))
    throw new TypeError('Expected JSON object.');
  return checked;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function scenario(value: unknown): import('./domain/types.ts').Scenario {
  insist(
    typeof value === 'string' && SCENARIO_NAMES.some((name) => name === value),
    'VALIDATION',
    '实验不存在。',
  );
  // Membership was checked against the closed union's canonical list.
  return value as import('./domain/types.ts').Scenario;
}

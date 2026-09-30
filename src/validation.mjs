import { createHash } from 'node:crypto';

export class DomainError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function insist(condition, code, message, status = 400) {
  if (!condition) throw new DomainError(code, message, status);
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const digest = value => createHash('sha256').update(value).digest('hex');

export function object(value, fields) {
  insist(value && typeof value === 'object' && !Array.isArray(value), 'VALIDATION', '请求必须是 JSON 对象。');
  insist(Object.keys(value).every(k => fields.includes(k)), 'VALIDATION', '请求含有不支持的字段。');
}

export function integer(value, min, max, name) {
  insist(Number.isSafeInteger(value) && value >= min && value <= max, 'VALIDATION', `${name} 必须是 ${min}–${max} 的整数。`);
  return value;
}

export function revision(value) {
  return integer(value, 1, Number.MAX_SAFE_INTEGER, 'expectedRevision');
}

export function key(value) {
  insist(typeof value === 'string' && /^[\w.:\-]{8,128}$/.test(value), 'IDEMPOTENCY_REQUIRED', '写入需要 8–128 字符的 Idempotency-Key。');
  return value;
}

export function jobDefinition(input) {
  object(input, ['kind', 'label', 'text', 'priority', 'maxAttempts', 'delayMs', 'scheduleMs', 'fault']);
  const kind = input.kind ?? 'digest';
  insist(['digest', 'csv_summary'].includes(kind), 'VALIDATION', '任务类型不受支持。');
  const label = input.label ?? 'Untitled task';
  insist(typeof label === 'string' && label.trim().length >= 1 && label.trim().length <= 80, 'VALIDATION', '任务名称需为 1–80 字符。');
  const text = input.text ?? 'Reliable systems leave evidence.';
  insist(typeof text === 'string' && Buffer.byteLength(text) <= 12000, 'VALIDATION', '任务输入不可超过 12 KB。');
  const fault = input.fault ?? {};
  object(fault, ['failFirst', 'crashOnce']);
  insist(fault.crashOnce === undefined || typeof fault.crashOnce === 'boolean', 'VALIDATION', 'crashOnce 必须是布尔值。');
  return {
    kind, label: label.trim(), text,
    priority: integer(input.priority ?? 0, 0, 5, 'priority'),
    maxAttempts: integer(input.maxAttempts ?? 4, 1, 5, 'maxAttempts'),
    delayMs: integer(input.delayMs ?? 550, 0, 8000, 'delayMs'),
    scheduleMs: integer(input.scheduleMs ?? 0, 0, 60000, 'scheduleMs'),
    fault: { failFirst: integer(fault.failFirst ?? 0, 0, 10, 'failFirst'), crashOnce: fault.crashOnce ?? false }
  };
}

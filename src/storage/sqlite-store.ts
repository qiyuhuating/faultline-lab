import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// The sole connection/transaction owner. SQL row assertions are confined here;
// repositories describe v1 schema rows, domain serialization checks lifecycle.
export class SqliteStore {
  readonly db: DatabaseSync;
  constructor(path: string, { readOnly = false }: { readOnly?: boolean } = {}) {
    if (!readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000, readOnly });
    try {
      const existing = this.one("SELECT name FROM sqlite_master WHERE name='meta'");
      if (existing) {
        if (this.metadata('schema_version') !== '1')
          throw new Error('Unsupported schema; database left unchanged.');
      }
      if (readOnly && !existing)
        throw new Error('Not a Faultline database; no files were modified.');
      if (!readOnly) {
        this.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
        if (!existing) this.run("INSERT OR IGNORE INTO meta VALUES ('event_anchor_seq', '0')");
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  one<T extends object = Record<string, unknown>>(
    sql: string,
    ...params: SQLInputValue[]
  ): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  all<T extends object>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  iterate<T extends object>(sql: string, ...params: SQLInputValue[]): Iterable<T> {
    return this.db.prepare(sql).iterate(...params) as Iterable<T>;
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }
  metadata(name: string): string | undefined {
    return this.one<{ value: string }>('SELECT value FROM meta WHERE key=?', name)?.value;
  }
  close() {
    this.db.close();
  }
  rollback(error: unknown): never {
    try {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Transaction and rollback failed.', {
        cause: error,
      });
    }
    throw error;
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      return this.rollback(error);
    }
  }
  readTransaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      return this.rollback(error);
    }
  }
}

import type { DatabaseSync } from 'node:sqlite';
import type { SettingsRepository } from '@shared/services';
import { nowIso } from '../../../domain/ids';

interface SettingsRow {
  key: string;
  value_json: string;
  updated_at: string;
}

export class SqliteSettingsRepository implements SettingsRepository {
  constructor(private readonly db: DatabaseSync) {}

  get<T>(key: string): T | undefined {
    const stmt = this.db.prepare('SELECT value_json FROM settings WHERE key = ?');
    const row = stmt.get(key) as SettingsRow | undefined;
    if (!row) {
      return undefined;
    }
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return undefined;
    }
  }

  set<T>(key: string, value: T): void {
    const now = nowIso();
    const valueJson = JSON.stringify(value);

    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `);

    stmt.run(key, valueJson, now);
  }

  delete(key: string): void {
    const stmt = this.db.prepare('DELETE FROM settings WHERE key = ?');
    stmt.run(key);
  }
}

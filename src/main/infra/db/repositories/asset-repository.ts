import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Asset, AssetRole } from '@shared/domain';
import { PodError } from '@shared/errors';
import type { AssetRepository } from '@shared/services';
import { newId, nowIso } from '../../../domain/ids';

interface AssetRow {
  id: string;
  product_id: string;
  job_id: string | null;
  role: AssetRole;
  path: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  sha256: string;
  created_at: string;
}

function mapRow(row: AssetRow): Asset {
  return {
    id: row.id,
    productId: row.product_id,
    jobId: row.job_id ?? null,
    role: row.role,
    path: row.path,
    mime: row.mime,
    bytes: row.bytes,
    width: row.width ?? null,
    height: row.height ?? null,
    durationMs: row.duration_ms ?? null,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

export class SqliteAssetRepository implements AssetRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(asset: Omit<Asset, 'id' | 'createdAt'>): Asset {
    // Validate path is relative only
    if (
      path.isAbsolute(asset.path) ||
      /^[a-zA-Z]:/.test(asset.path) ||
      asset.path.startsWith('/') ||
      asset.path.startsWith('\\') ||
      asset.path.split(/[\\/]/).includes('..')
    ) {
      throw new PodError('INTERNAL', 'Asset path must be relative');
    }

    const id = newId();
    const createdAt = nowIso();

    const stmt = this.db.prepare(`
      INSERT INTO assets (
        id, product_id, job_id, role, path, mime, bytes, width, height, duration_ms, sha256, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    stmt.run(
      id,
      asset.productId,
      asset.jobId ?? null,
      asset.role,
      asset.path,
      asset.mime,
      asset.bytes,
      asset.width ?? null,
      asset.height ?? null,
      asset.durationMs ?? null,
      asset.sha256,
      createdAt,
    );

    return this.getById(id)!;
  }

  getById(id: string): Asset | null {
    const stmt = this.db.prepare('SELECT * FROM assets WHERE id = ?');
    const row = stmt.get(id) as unknown as AssetRow | undefined;
    return row ? mapRow(row) : null;
  }

  listByJob(jobId: string): Asset[] {
    const stmt = this.db.prepare('SELECT * FROM assets WHERE job_id = ? ORDER BY created_at ASC');
    const rows = stmt.all(jobId) as unknown as AssetRow[];
    return rows.map(mapRow);
  }

  listByProduct(productId: string): Asset[] {
    const stmt = this.db.prepare('SELECT * FROM assets WHERE product_id = ? ORDER BY created_at ASC');
    const rows = stmt.all(productId) as unknown as AssetRow[];
    return rows.map(mapRow);
  }

  delete(id: string): void {
    const stmt = this.db.prepare('DELETE FROM assets WHERE id = ?');
    stmt.run(id);
  }
}

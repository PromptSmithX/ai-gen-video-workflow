import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PodError } from '@shared/errors';
import type { NewJob, PodDatabase } from '@shared/services';
import { newId } from '../../domain/ids';
import { openDatabase, restoreFrom } from './index';
import { MIGRATIONS } from './migrations';

describe('Database and Repositories', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-db-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('Migrations', () => {
    it('applies migrations to fresh db, records version, and is idempotent on re-open', () => {
      const dbPath = path.join(tmpDir, 'test.db');
      const db1 = openDatabase(dbPath);

      // Verify schema_migrations table
      const rawDb = new DatabaseSync(dbPath);
      const rows = rawDb.prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC').all() as Array<{
        version: number;
        name: string;
      }>;
      expect(rows).toHaveLength(2);
      expect(rows[0]?.version).toBe(1);
      expect(rows[0]?.name).toBe('initial_schema');
      expect(rows[1]?.version).toBe(2);
      expect(rows[1]?.name).toBe('assets_interior_artwork_role');
      rawDb.close();
      db1.close();

      // Re-open
      const db2 = openDatabase(dbPath);
      const rawDb2 = new DatabaseSync(dbPath);
      const rows2 = rawDb2.prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC').all() as Array<{
        version: number;
        name: string;
      }>;
      expect(rows2).toHaveLength(2);
      expect(rows2[0]?.version).toBe(1);
      expect(rows2[1]?.version).toBe(2);
      rawDb2.close();
      db2.close();
    });

    it('migrates v1 database to v2: preserves all rows across 4 old roles, recreates indexes, allows interior_artwork and rejects invalid role', () => {
      const dbPath = path.join(tmpDir, 'v1_upgrade.db');
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
      `);

      // Run v1 migration only
      MIGRATIONS[0]!.up(rawDb);
      rawDb.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (1, 'initial_schema', '${new Date().toISOString()}');
      `);

      // Insert product and job
      rawDb.exec(`
        INSERT INTO products (id, sku, category, product_name, created_at, updated_at)
        VALUES ('prod-1', 'SKU-001', 't-shirt', 'T-Shirt 1', '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z');

        INSERT INTO jobs (
          id, product_id, sku_snapshot, employee_id, provider, source_asset_id,
          prompt_template_id, prompt_template_version, prompt_sha256, prompt_overridden,
          state, idempotency_key, attempt, review_status, created_at, updated_at
        ) VALUES (
          'job-1', 'prod-1', 'SKU-001', 'emp-1', 'muse', 'asset-source',
          'tpl-1', 'v1', 'hash-prompt', 0,
          'QUEUED', 'key-1', 0, 'pending', '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z'
        );
      `);

      // Insert asset rows for all 4 old roles
      const oldAssets = [
        {
          id: 'asset-1',
          product_id: 'prod-1',
          job_id: null,
          role: 'source_image',
          path: 'SKU-001/source/orig.png',
          mime: 'image/png',
          bytes: 1234,
          width: 800,
          height: 600,
          duration_ms: null,
          sha256: 'sha-source',
          created_at: '2026-11-25T01:00:00.000Z',
        },
        {
          id: 'asset-2',
          product_id: 'prod-1',
          job_id: 'job-1',
          role: 'generated_video',
          path: 'SKU-001/videos/SKU-001-video-001.mp4',
          mime: 'video/mp4',
          bytes: 54321,
          width: null,
          height: null,
          duration_ms: 5000,
          sha256: 'sha-video',
          created_at: '2026-11-25T02:00:00.000Z',
        },
        {
          id: 'asset-3',
          product_id: 'prod-1',
          job_id: 'job-1',
          role: 'thumbnail',
          path: 'SKU-001/thumbnails/thumb.jpg',
          mime: 'image/jpeg',
          bytes: 432,
          width: 200,
          height: 150,
          duration_ms: null,
          sha256: 'sha-thumb',
          created_at: '2026-11-25T03:00:00.000Z',
        },
        {
          id: 'asset-4',
          product_id: 'prod-1',
          job_id: 'job-1',
          role: 'prompt_snapshot',
          path: 'SKU-001/prompts/prompt.md',
          mime: 'text/markdown',
          bytes: 50,
          width: null,
          height: null,
          duration_ms: null,
          sha256: 'sha-prompt',
          created_at: '2026-11-25T04:00:00.000Z',
        },
      ];

      const insertStmt = rawDb.prepare(`
        INSERT INTO assets (
          id, product_id, job_id, role, path, mime, bytes, width, height, duration_ms, sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const a of oldAssets) {
        insertStmt.run(
          a.id,
          a.product_id,
          a.job_id,
          a.role,
          a.path,
          a.mime,
          a.bytes,
          a.width,
          a.height,
          a.duration_ms,
          a.sha256,
          a.created_at,
        );
      }

      // Verify v1 rejects interior_artwork before migration
      expect(() => {
        insertStmt.run(
          'asset-cal-fail',
          'prod-1',
          'job-1',
          'interior_artwork',
          'SKU-001/source/art.png',
          'image/png',
          500,
          null,
          null,
          null,
          'sha-cal',
          '2026-11-25T05:00:00.000Z',
        );
      }).toThrow();

      rawDb.close();

      // Now open through openDatabase which runs runMigrations()
      const podDb = openDatabase(dbPath);

      // Verify schema_migrations now contains version 2
      const postDb = new DatabaseSync(dbPath);
      const migRows = postDb.prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC').all() as Array<{
        version: number;
        name: string;
      }>;
      expect(migRows).toHaveLength(2);
      expect(migRows[1]?.version).toBe(2);
      expect(migRows[1]?.name).toBe('assets_interior_artwork_role');

      // Verify every old asset row is identical across all columns
      const migratedAssets = postDb.prepare('SELECT * FROM assets ORDER BY id ASC').all();
      expect(migratedAssets).toEqual(oldAssets);

      // Verify indexes exist
      const indexRows = postDb.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'assets'
      `).all() as Array<{ name: string }>;
      const indexNames = indexRows.map((r) => r.name);
      expect(indexNames).toContain('idx_assets_product_id');
      expect(indexNames).toContain('idx_assets_job_id');

      // Verify inserting interior_artwork works now
      const newAsset = podDb.assets.insert({
        productId: 'prod-1',
        jobId: 'job-1',
        role: 'interior_artwork',
        path: 'SKU-001/source/SKU-001-interior-artwork.png',
        mime: 'image/png',
        bytes: 2048,
        width: 1024,
        height: 768,
        durationMs: null,
        sha256: 'sha-cal-valid',
      });
      expect(newAsset.id).toBeDefined();
      expect(newAsset.role).toBe('interior_artwork');

      // Verify round-tripping via repository
      const fetched = podDb.assets.getById(newAsset.id);
      expect(fetched).toEqual(newAsset);

      const jobAssets = podDb.assets.listByJob('job-1');
      expect(jobAssets.some((a) => a.role === 'interior_artwork')).toBe(true);

      const prodAssets = podDb.assets.listByProduct('prod-1');
      expect(prodAssets.some((a) => a.role === 'interior_artwork')).toBe(true);

      // Verify an unknown role still fails the CHECK constraint
      expect(() => {
        postDb.prepare(`
          INSERT INTO assets (
            id, product_id, job_id, role, path, mime, bytes, width, height, duration_ms, sha256, created_at
          ) VALUES (
            'asset-invalid', 'prod-1', 'job-1', 'unknown_role', 'p.png', 'image/png', 10, null, null, null, 'sha', '2026-11-25'
          )
        `).run();
      }).toThrow();

      postDb.close();
      podDb.close();

      // Verify re-opening is idempotent
      const reopenDb = openDatabase(dbPath);
      const reopenAssets = reopenDb.assets.listByProduct('prod-1');
      expect(reopenAssets).toHaveLength(5); // 4 old + 1 new interior_artwork
      reopenDb.close();
    });

    it('works with :memory:', () => {
      const db = openDatabase(':memory:');
      expect(db.products.list()).toEqual([]);
      db.close();
    });
  });

  describe('ProductRepository', () => {
    let db: PodDatabase;

    beforeEach(() => {
      db = openDatabase(':memory:');
    });

    afterEach(() => {
      db.close();
    });

    it('upsertBySku creates product and updates on duplicate SKU', () => {
      const p1 = db.products.upsertBySku({
        sku: 'TSHIRT-001',
        category: 't-shirt',
        productName: 'Cool T-Shirt',
      });

      expect(p1.id).toBeDefined();
      expect(p1.sku).toBe('TSHIRT-001');
      expect(p1.category).toBe('t-shirt');
      expect(p1.productName).toBe('Cool T-Shirt');

      // Retrieve
      const fetched = db.products.getBySku('TSHIRT-001');
      expect(fetched).toEqual(p1);

      const fetchedById = db.products.getById(p1.id);
      expect(fetchedById).toEqual(p1);

      // Upsert update
      const p2 = db.products.upsertBySku({
        sku: 'TSHIRT-001',
        category: 't-shirt',
        productName: 'Cooler T-Shirt',
      });

      expect(p2.id).toBe(p1.id);
      expect(p2.productName).toBe('Cooler T-Shirt');

      const all = db.products.list();
      expect(all).toHaveLength(1);
      expect(all[0]?.productName).toBe('Cooler T-Shirt');
    });
  });

  describe('JobRepository', () => {
    let db: PodDatabase;
    let productId: string;
    let sourceAssetId: string;

    beforeEach(() => {
      db = openDatabase(':memory:');
      const prod = db.products.upsertBySku({
        sku: 'MUG-001',
        category: 'mug',
        productName: 'Coffee Mug',
      });
      productId = prod.id;

      const asset = db.assets.insert({
        productId,
        jobId: null,
        role: 'source_image',
        path: 'MUG-001/source/MUG-001-original.png',
        mime: 'image/png',
        bytes: 1024,
        width: 100,
        height: 100,
        durationMs: null,
        sha256: 'abc123hash',
      });
      sourceAssetId = asset.id;
    });

    afterEach(() => {
      db.close();
    });

    function makeJobInput(overrides?: Partial<NewJob>): NewJob {
      const base: NewJob = {
        id: newId(),
        productId,
        skuSnapshot: 'MUG-001',
        employeeId: 'emp-42',
        provider: 'muse',
        sourceAssetId,
        promptTemplateId: 'product-review-v1',
        promptTemplateVersion: '1.0',
        promptSha256: 'prompt-digest',
        promptOverridden: false,
        durationSeconds: 5,
        aspectRatio: '9:16',
        idempotencyKey: newId(),
        regeneratedFromJobId: null,
      };
      return {
        ...base,
        ...overrides,
        provider: 'muse',
      };
    }

    it('inserts a new job and enforces unique idempotency key with PodError(INVALID_STATE)', () => {
      const key = newId();
      const input1 = makeJobInput({ idempotencyKey: key });
      const job1 = db.jobs.insert(input1);

      expect(job1.id).toBe(input1.id);
      expect(job1.state).toBe('QUEUED');
      expect(job1.attempt).toBe(0);
      expect(job1.reviewStatus).toBe('pending');
      expect(job1.idempotencyKey).toBe(key);

      const input2 = makeJobInput({ id: newId(), idempotencyKey: key });
      expect(() => db.jobs.insert(input2)).toThrow(PodError);
      try {
        db.jobs.insert(input2);
      } catch (err: unknown) {
        expect((err as PodError).code).toBe('INVALID_STATE');
      }
    });

    it('supports allowed transitions and rejects forbidden transitions', () => {
      const job = db.jobs.insert(makeJobInput());
      expect(job.state).toBe('QUEUED');

      // Valid: QUEUED -> SUBMITTING
      const s1 = db.jobs.transition(job.id, 'SUBMITTING', { submitIntentAt: new Date().toISOString() });
      expect(s1.state).toBe('SUBMITTING');
      expect(s1.submitIntentAt).toBeDefined();

      // Valid: SUBMITTING -> RUNNING
      const s2 = db.jobs.transition(job.id, 'RUNNING', {
        providerJobId: 'prov-123',
        acceptedAt: new Date().toISOString(),
      });
      expect(s2.state).toBe('RUNNING');
      expect(s2.providerJobId).toBe('prov-123');

      // Invalid: RUNNING -> QUEUED
      expect(() => db.jobs.transition(job.id, 'QUEUED')).toThrow(PodError);
      try {
        db.jobs.transition(job.id, 'QUEUED');
      } catch (err: unknown) {
        expect((err as PodError).code).toBe('INVALID_STATE');
      }
    });

    it('detects concurrent state changes between read and transition', () => {
      const job = db.jobs.insert(makeJobInput());

      // Simulate a concurrent update directly in SQLite
      const rawDb = (db as unknown as { jobs: { db: DatabaseSync } }).jobs.db;
      rawDb.prepare("UPDATE jobs SET state = 'SUBMITTING' WHERE id = ?").run(job.id);

      // Now attempt transition from QUEUED -> CANCELLED
      // But job is actually SUBMITTING now!
      expect(() => db.jobs.transition(job.id, 'CANCELLED')).toThrow(PodError);
      try {
        db.jobs.transition(job.id, 'CANCELLED');
      } catch (err: unknown) {
        expect((err as PodError).code).toBe('INVALID_STATE');
      }
    });

    it('supports list filters and sorting newest first with default limit 200', () => {
      const prod2 = db.products.upsertBySku({ sku: 'HOODIE-002', category: 'hoodie', productName: 'Hoodie' });

      const j1 = db.jobs.insert(makeJobInput({ skuSnapshot: 'MUG-001', employeeId: 'alice' }));
      const j2 = db.jobs.insert(
        makeJobInput({
          productId: prod2.id,
          skuSnapshot: 'HOODIE-002',
          employeeId: 'bob',
          state: 'RUNNING',
        }),
      );

      // Filter by SKU
      const bySku = db.jobs.list({ sku: 'MUG-001' });
      expect(bySku.map((j) => j.id)).toContain(j1.id);
      expect(bySku.map((j) => j.id)).not.toContain(j2.id);

      // Filter by category
      const byCat = db.jobs.list({ category: 'hoodie' });
      expect(byCat.map((j) => j.id)).toContain(j2.id);
      expect(byCat.map((j) => j.id)).not.toContain(j1.id);

      // Filter by employee
      const byEmp = db.jobs.list({ employeeId: 'alice' });
      expect(byEmp.map((j) => j.id)).toEqual([j1.id]);

      // Filter by state
      const byState = db.jobs.list({ states: ['RUNNING'] });
      expect(byState.map((j) => j.id)).toEqual([j2.id]);

      // Active jobs (oldest first)
      const active = db.jobs.listActive();
      expect(active).toHaveLength(2);
      expect(active[0]?.id).toBe(j1.id);
      expect(active[1]?.id).toBe(j2.id);
    });

    it('updates non-state fields using update()', () => {
      const job = db.jobs.insert(makeJobInput());
      const updated = db.jobs.update(job.id, {
        providerReferenceId: 'ref-999',
        attempt: 1,
        reviewStatus: 'approved',
      });

      expect(updated.providerReferenceId).toBe('ref-999');
      expect(updated.attempt).toBe(1);
      expect(updated.reviewStatus).toBe('approved');
      expect(updated.state).toBe(job.state);
    });
  });

  describe('AssetRepository', () => {
    let db: PodDatabase;
    let productId: string;

    beforeEach(() => {
      db = openDatabase(':memory:');
      const prod = db.products.upsertBySku({ sku: 'POSTER-01', category: 'poster', productName: null });
      productId = prod.id;
    });

    afterEach(() => {
      db.close();
    });

    it('inserts asset with relative path and rejects absolute paths', () => {
      const asset = db.assets.insert({
        productId,
        jobId: null,
        role: 'source_image',
        path: 'POSTER-01/source/POSTER-01-original.png',
        mime: 'image/png',
        bytes: 500,
        width: 100,
        height: 200,
        durationMs: null,
        sha256: 'hash1',
      });

      expect(asset.id).toBeDefined();
      expect(asset.path).toBe('POSTER-01/source/POSTER-01-original.png');

      // Absolute path must be rejected
      expect(() =>
        db.assets.insert({
          productId,
          jobId: null,
          role: 'source_image',
          path: 'C:\\escaped\\file.png',
          mime: 'image/png',
          bytes: 500,
          width: 100,
          height: 200,
          durationMs: null,
          sha256: 'hash2',
        }),
      ).toThrow(PodError);

      expect(() =>
        db.assets.insert({
          productId,
          jobId: null,
          role: 'source_image',
          path: '/escaped/file.png',
          mime: 'image/png',
          bytes: 500,
          width: 100,
          height: 200,
          durationMs: null,
          sha256: 'hash3',
        }),
      ).toThrow(PodError);
    });

    it('lists and deletes assets', () => {
      const a = db.assets.insert({
        productId,
        jobId: null,
        role: 'source_image',
        path: 'POSTER-01/source/orig.png',
        mime: 'image/png',
        bytes: 100,
        width: null,
        height: null,
        durationMs: null,
        sha256: 'h1',
      });

      expect(db.assets.listByProduct(productId)).toHaveLength(1);
      db.assets.delete(a.id);
      expect(db.assets.listByProduct(productId)).toHaveLength(0);
      expect(db.assets.getById(a.id)).toBeNull();
    });
  });

  describe('SettingsRepository', () => {
    let db: PodDatabase;

    beforeEach(() => {
      db = openDatabase(':memory:');
    });

    afterEach(() => {
      db.close();
    });

    it('round trips setting values including complex objects', () => {
      expect(db.settings.get('foo')).toBeUndefined();

      const val = { enabled: true, retries: 3, tags: ['a', 'b'] };
      db.settings.set('my_setting', val);
      expect(db.settings.get('my_setting')).toEqual(val);

      // Overwrite
      db.settings.set('my_setting', { enabled: false });
      expect(db.settings.get('my_setting')).toEqual({ enabled: false });

      // Delete
      db.settings.delete('my_setting');
      expect(db.settings.get('my_setting')).toBeUndefined();
    });
  });

  describe('Transactions and Backup/Restore', () => {
    it('commits transaction on success and rolls back on exception', () => {
      const db = openDatabase(':memory:');

      db.transaction(() => {
        db.products.upsertBySku({ sku: 'SKU-TX-1', category: 't-shirt', productName: 'P1' });
      });
      expect(db.products.getBySku('SKU-TX-1')).not.toBeNull();

      expect(() => {
        db.transaction(() => {
          db.products.upsertBySku({ sku: 'SKU-TX-2', category: 't-shirt', productName: 'P2' });
          throw new Error('boom');
        });
      }).toThrow('boom');

      expect(db.products.getBySku('SKU-TX-2')).toBeNull();
      db.close();
    });

    it('(a) failing transaction followed by a normal insert -> close + reopen file db -> the insert is persisted', () => {
      const dbPath = path.join(tmpDir, 'test_tx_rollback.db');
      let db = openDatabase(dbPath);

      // Failing transaction
      expect(() => {
        db.transaction(() => {
          db.products.upsertBySku({ sku: 'FAIL-1', category: 't-shirt', productName: 'Failed' });
          throw new Error('tx failed');
        });
      }).toThrow('tx failed');

      // Normal insert outside transaction
      db.products.upsertBySku({ sku: 'PERSIST-1', category: 't-shirt', productName: 'Persisted' });

      // Close and reopen
      db.close();
      db = openDatabase(dbPath);

      expect(db.products.getBySku('FAIL-1')).toBeNull();
      const persisted = db.products.getBySku('PERSIST-1');
      expect(persisted).not.toBeNull();
      expect(persisted?.productName).toBe('Persisted');
      db.close();
    });

    it('(b) nested transaction where inner throws and outer catches -> outer writes persist', () => {
      const dbPath = path.join(tmpDir, 'test_tx_nested.db');
      let db = openDatabase(dbPath);

      db.transaction(() => {
        db.products.upsertBySku({ sku: 'OUTER-1', category: 't-shirt', productName: 'Outer 1' });

        try {
          db.transaction(() => {
            db.products.upsertBySku({ sku: 'INNER-FAIL', category: 't-shirt', productName: 'Inner' });
            throw new Error('inner failure');
          });
        } catch {
          // outer catches inner failure
        }

        db.products.upsertBySku({ sku: 'OUTER-2', category: 't-shirt', productName: 'Outer 2' });
      });

      db.close();
      db = openDatabase(dbPath);

      expect(db.products.getBySku('INNER-FAIL')).toBeNull();
      expect(db.products.getBySku('OUTER-1')?.productName).toBe('Outer 1');
      expect(db.products.getBySku('OUTER-2')?.productName).toBe('Outer 2');
      db.close();
    });

    it('backup and restore round trip preserves rows', async () => {
      const livePath = path.join(tmpDir, 'live.db');
      const backupPath = path.join(tmpDir, 'backup.db');
      const restoredPath = path.join(tmpDir, 'restored.db');

      const db = openDatabase(livePath);
      db.products.upsertBySku({ sku: 'SKU-BACKUP-1', category: 'mug', productName: 'Backup Mug' });
      db.settings.set('key1', { saved: true });

      await db.backup(backupPath);
      db.close();

      expect(fs.existsSync(backupPath)).toBe(true);

      // Restore to restoredPath
      restoreFrom(backupPath, restoredPath);

      const restoredDb = openDatabase(restoredPath);
      const prod = restoredDb.products.getBySku('SKU-BACKUP-1');
      expect(prod).not.toBeNull();
      expect(prod?.productName).toBe('Backup Mug');
      expect(restoredDb.settings.get('key1')).toEqual({ saved: true });
      restoredDb.close();
    });
  });
});

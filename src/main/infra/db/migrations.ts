import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up(db: DatabaseSync): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS products (
          id TEXT PRIMARY KEY,
          sku TEXT UNIQUE NOT NULL,
          category TEXT NOT NULL,
          product_name TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(id),
          sku_snapshot TEXT NOT NULL,
          employee_id TEXT NOT NULL,
          provider TEXT NOT NULL CHECK(provider = 'muse'),
          provider_job_id TEXT,
          provider_reference_id TEXT,
          provider_asset_id TEXT,
          source_asset_id TEXT NOT NULL,
          prompt_template_id TEXT NOT NULL,
          prompt_template_version TEXT NOT NULL,
          prompt_sha256 TEXT NOT NULL,
          prompt_overridden INTEGER NOT NULL CHECK(prompt_overridden IN (0, 1)),
          duration_seconds INTEGER,
          aspect_ratio TEXT,
          state TEXT NOT NULL CHECK(state IN (
            'DRAFT',
            'READY',
            'QUEUED',
            'SUBMITTING',
            'RUNNING',
            'DOWNLOADING',
            'SUCCEEDED',
            'FAILED_RETRYABLE',
            'AMBIGUOUS',
            'FAILED_REFUSED',
            'FAILED_QUOTA',
            'FAILED_PROVIDER',
            'DOWNLOAD_FAILED',
            'CANCELLED'
          )),
          idempotency_key TEXT UNIQUE NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 0,
          regenerated_from_job_id TEXT,
          review_status TEXT NOT NULL CHECK(review_status IN ('pending', 'approved', 'rejected')),
          submit_intent_at TEXT,
          accepted_at TEXT,
          completed_at TEXT,
          error_code TEXT,
          safe_error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
        CREATE INDEX IF NOT EXISTS idx_jobs_sku_snapshot ON jobs(sku_snapshot);
        CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);

        CREATE TABLE IF NOT EXISTS assets (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(id),
          job_id TEXT REFERENCES jobs(id),
          role TEXT NOT NULL CHECK(role IN ('source_image', 'generated_video', 'thumbnail', 'prompt_snapshot')),
          path TEXT NOT NULL,
          mime TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          width INTEGER,
          height INTEGER,
          duration_ms INTEGER,
          sha256 TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_assets_product_id ON assets(product_id);
        CREATE INDEX IF NOT EXISTS idx_assets_job_id ON assets(job_id);

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    name: 'assets_interior_artwork_role',
    up(db: DatabaseSync): void {
      db.exec(`
        CREATE TABLE assets_new (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(id),
          job_id TEXT REFERENCES jobs(id),
          role TEXT NOT NULL CHECK(role IN ('source_image', 'generated_video', 'thumbnail', 'prompt_snapshot', 'interior_artwork')),
          path TEXT NOT NULL,
          mime TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          width INTEGER,
          height INTEGER,
          duration_ms INTEGER,
          sha256 TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        INSERT INTO assets_new (
          id, product_id, job_id, role, path, mime, bytes, width, height, duration_ms, sha256, created_at
        )
        SELECT
          id, product_id, job_id, role, path, mime, bytes, width, height, duration_ms, sha256, created_at
        FROM assets;

        DROP TABLE assets;

        ALTER TABLE assets_new RENAME TO assets;

        CREATE INDEX IF NOT EXISTS idx_assets_product_id ON assets(product_id);
        CREATE INDEX IF NOT EXISTS idx_assets_job_id ON assets(job_id);
      `);
    },
  },
  {
    version: 3,
    name: 'jobs_two_clip_segments',
    up(db: DatabaseSync): void {
      // Two-clip calendar jobs: which clip is in flight, and where clip A was saved.
      db.exec(`
        ALTER TABLE jobs ADD COLUMN segment INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE jobs ADD COLUMN segment_a_path TEXT;
      `);
    },
  },
];

/**
 * Runs pending migrations within transactions. Idempotent on re-open.
 */
export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{
    version: number;
  }>;
  const appliedSet = new Set(appliedRows.map((r) => r.version));

  for (const migration of MIGRATIONS) {
    if (appliedSet.has(migration.version)) {
      continue;
    }

    db.exec(`SAVEPOINT migration_${migration.version}`);
    try {
      migration.up(db);
      const insertStmt = db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      );
      insertStmt.run(migration.version, migration.name, new Date().toISOString());
      db.exec(`RELEASE SAVEPOINT migration_${migration.version}`);
    } catch (err) {
      db.exec(`ROLLBACK TO SAVEPOINT migration_${migration.version}`);
      throw err;
    }
  }
}

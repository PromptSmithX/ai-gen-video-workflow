import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  AssetRepository,
  JobRepository,
  PodDatabase,
  ProductRepository,
  SettingsRepository,
} from '@shared/services';
import { runMigrations } from './migrations';
import { SqliteAssetRepository } from './repositories/asset-repository';
import { SqliteJobRepository } from './repositories/job-repository';
import { SqliteProductRepository } from './repositories/product-repository';
import { SqliteSettingsRepository } from './repositories/settings-repository';

/**
 * Restores a SQLite database file from a backup file by copying it when closed.
 */
export function restoreFrom(backupPath: string, targetPath: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(backupPath, targetPath);
}

/**
 * Opens a SQLite database using node:sqlite DatabaseSync, configures pragmas,
 * runs migrations, and returns the PodDatabase interface.
 */
export function openDatabase(filePath: string): PodDatabase {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const db = new DatabaseSync(filePath);

  // Configure pragmas: journal_mode=WAL, foreign_keys=ON, busy_timeout=5000
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

  // Run migrations
  runMigrations(db);

  const productsRepo: ProductRepository = new SqliteProductRepository(db);
  const jobsRepo: JobRepository = new SqliteJobRepository(db);
  const assetsRepo: AssetRepository = new SqliteAssetRepository(db);
  const settingsRepo: SettingsRepository = new SqliteSettingsRepository(db);

  let savepointCounter = 0;

  return {
    get products(): ProductRepository {
      return productsRepo;
    },
    get jobs(): JobRepository {
      return jobsRepo;
    },
    get assets(): AssetRepository {
      return assetsRepo;
    },
    get settings(): SettingsRepository {
      return settingsRepo;
    },
    transaction<T>(fn: () => T): T {
      const sp = `tx_${++savepointCounter}`;
      db.exec(`SAVEPOINT ${sp}`);
      try {
        const result = fn();
        db.exec(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        db.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp};`);
        throw err;
      }
    },
    async backup(destPath: string): Promise<void> {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      const stmt = db.prepare('VACUUM INTO ?') as StatementSync;
      stmt.run(destPath);
    },
    close(): void {
      db.close();
    },
  };
}

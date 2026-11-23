import type { DatabaseSync } from 'node:sqlite';
import type { Product } from '@shared/domain';
import type { ProductRepository } from '@shared/services';
import { newId, nowIso } from '../../../domain/ids';

interface ProductRow {
  id: string;
  sku: string;
  category: string;
  product_name: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    category: row.category,
    productName: row.product_name ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteProductRepository implements ProductRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsertBySku(input: { sku: string; category: string; productName: string | null }): Product {
    const now = nowIso();
    const id = newId();

    const stmt = this.db.prepare(`
      INSERT INTO products (id, sku, category, product_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sku) DO UPDATE SET
        category = excluded.category,
        product_name = excluded.product_name,
        updated_at = excluded.updated_at
      RETURNING id, sku, category, product_name, created_at, updated_at
    `);

    const row = stmt.get(id, input.sku, input.category, input.productName, now, now) as unknown as ProductRow;
    return mapRow(row);
  }

  getById(id: string): Product | null {
    const stmt = this.db.prepare('SELECT * FROM products WHERE id = ?');
    const row = stmt.get(id) as unknown as ProductRow | undefined;
    return row ? mapRow(row) : null;
  }

  getBySku(sku: string): Product | null {
    const stmt = this.db.prepare('SELECT * FROM products WHERE sku = ?');
    const row = stmt.get(sku) as unknown as ProductRow | undefined;
    return row ? mapRow(row) : null;
  }

  list(): Product[] {
    const stmt = this.db.prepare('SELECT * FROM products ORDER BY created_at DESC');
    const rows = stmt.all() as unknown as ProductRow[];
    return rows.map(mapRow);
  }
}

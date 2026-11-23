import { DatabaseSync } from 'node:sqlite';
import { canTransition, normalizeSku } from './index';

describe('shared contracts', () => {
  it('normalizes and rejects SKUs', () => {
    expect(normalizeSku('  ts-001 ')).toBe('TS-001');
    expect(normalizeSku('../etc')).toBeNull();
    expect(normalizeSku('a/b')).toBeNull();
    expect(normalizeSku('a\\b')).toBeNull();
    expect(normalizeSku('')).toBeNull();
    expect(normalizeSku('CON')).toBeNull();
    expect(normalizeSku(42)).toBeNull();
  });

  it('never allows SUBMITTING -> QUEUED (no automatic resubmit)', () => {
    expect(canTransition('SUBMITTING', 'QUEUED')).toBe(false);
    expect(canTransition('AMBIGUOUS', 'QUEUED')).toBe(false);
    expect(canTransition('SUBMITTING', 'AMBIGUOUS')).toBe(true);
  });

  it('can load the native sqlite driver in the test runtime', () => {
    const db = new DatabaseSync(':memory:');
    expect(db.prepare('select 1 as x').get()).toMatchObject({ x: 1 });
    db.close();
  });
});

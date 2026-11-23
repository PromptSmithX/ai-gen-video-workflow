import fs from 'node:fs';
import path from 'node:path';
import { normalizeSku } from '@shared/domain';
import { PodError } from '@shared/errors';

/**
 * Checks whether `child` is inside `parent` (or identical to `parent`).
 */
function isInside(parent: string, child: string): boolean {
  const normParent = path.resolve(parent);
  const normChild = path.resolve(child);

  if (process.platform === 'win32') {
    if (normParent.slice(0, 2).toLowerCase() !== normChild.slice(0, 2).toLowerCase()) {
      return false;
    }
  }

  const rel = path.relative(normParent, normChild);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Validates SKU, creates subfolders if needed, and returns the absolute SKU directory.
 * Subfolders: source, prompts, videos, metadata.
 */
export function getSkuDir(root: string, sku: string): string {
  const normalized = normalizeSku(sku);
  if (!normalized) {
    throw new PodError('INVALID_SKU', 'Invalid SKU format');
  }

  const skuPath = path.join(root, normalized);
  const rel = path.relative(root, skuPath);

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PodError('INVALID_SKU', 'SKU escapes root');
  }

  // Ensure standard subdirectories
  for (const sub of ['source', 'prompts', 'videos', 'metadata']) {
    const subDir = path.join(skuPath, sub);
    const subRel = path.relative(root, subDir);
    if (subRel.startsWith('..') || path.isAbsolute(subRel)) {
      throw new PodError('INVALID_SKU', 'SKU subdirectory escapes root');
    }
  }

  return skuPath;
}

/**
 * Resolves a relative path inside root.
 * Rejects absolute input, '..' segments, drive letters, UNC, NUL bytes,
 * and checks with fs.realpathSync that the real path does not escape real root
 * (protecting against symlink and junction escape).
 */
export function resolveSafe(root: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.includes('\0')) {
    throw new PodError('FORBIDDEN', 'Invalid path characters');
  }

  if (path.isAbsolute(relPath)) {
    throw new PodError('FORBIDDEN', 'Absolute paths are forbidden');
  }

  // Reject drive letters like C: or D:
  if (/^[a-zA-Z]:/.test(relPath)) {
    throw new PodError('FORBIDDEN', 'Drive letters are forbidden in relative paths');
  }

  // Reject UNC paths like \\server\share or //server/share
  if (/^(\\\\|\/\/)/.test(relPath)) {
    throw new PodError('FORBIDDEN', 'UNC paths are forbidden');
  }

  // Reject '..' or segments containing ':'
  const segments = relPath.split(/[\\/]/);
  for (const seg of segments) {
    if (seg === '..' || seg.includes(':')) {
      throw new PodError('FORBIDDEN', 'Path traversal is forbidden');
    }
  }

  const target = path.resolve(root, relPath);
  if (!isInside(root, target)) {
    throw new PodError('FORBIDDEN', 'Path escapes library root');
  }

  // Check real paths (symlink / junction escape check)
  if (fs.existsSync(root)) {
    const realRoot = fs.realpathSync(root);

    // Find the deepest existing ancestor of target
    let curr = target;
    while (!fs.existsSync(curr)) {
      const parent = path.dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }

    if (fs.existsSync(curr)) {
      const realCurr = fs.realpathSync(curr);
      if (!isInside(realRoot, realCurr)) {
        throw new PodError('FORBIDDEN', 'Path escapes library root via symlink or junction');
      }
    }
  }

  return target;
}

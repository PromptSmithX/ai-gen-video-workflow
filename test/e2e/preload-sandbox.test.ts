import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The preload runs with `sandbox: true`, where `require` only resolves "electron" (and a few Node builtins).
 * Any runtime import of a node_modules package (e.g. zod via src/shared/ipc.ts) makes the preload throw and
 * `window.api` is never exposed — the UI then shows "Application backend is unavailable".
 */
const ROOT = path.resolve(__dirname, '../..');

function runtimeImports(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /^\s*import\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]!);
  return out;
}

describe('sandboxed preload', () => {
  it('only imports electron and the dependency-free IPC channel module at runtime', () => {
    const imports = runtimeImports(path.join(ROOT, 'src/preload/index.ts'));
    for (const spec of imports) {
      expect(['electron', '../shared/ipc-channels']).toContain(spec);
    }
  });

  it('ipc-channels.ts has no imports at all', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/shared/ipc-channels.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
  });

  it('built preload (if present) requires nothing but electron', () => {
    const built = path.join(ROOT, 'out/preload/index.js');
    if (!fs.existsSync(built)) return;
    const requires = [...fs.readFileSync(built, 'utf8').matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    for (const r of requires) expect(r).toBe('electron');
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Logger, SecretName, SecretStore } from '@shared/services';
import { Muse4aiSupervisor, type Muse4aiSupervisorDeps } from './supervisor';

const BASE = 'http://127.0.0.1:47821';

function logger(): Logger {
  const l: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l };
  return l;
}

function memSecrets(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    isAvailable: () => true,
    get: (n: SecretName) => data.get(n) ?? null,
    set: (n: SecretName, v: string) => void data.set(n, v),
    delete: (n: SecretName) => void data.delete(n),
  };
}

/** Fake Muse4AI: `up`/`pod` control /v1/health; a spawn with --pod-bootstrap writes `issueKey` to keyOut. */
function rig(opts: { up?: boolean; pod?: boolean; validKey?: string | null; issueKey?: string | null; startsOnSpawn?: boolean }) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-m4a-'));
  const secrets = memSecrets();
  const spawns: string[][] = [];
  const world = { up: opts.up ?? false, pod: opts.pod ?? true, validKey: opts.validKey ?? null };
  let clock = 0;
  const deps: Muse4aiSupervisorDeps = {
    exePath: 'C:/fake/Muse4AI.exe',
    bridgeBaseUrl: BASE,
    proxyPort: 8080,
    workDir,
    secrets,
    getApiKey: () => secrets.get('bridge_api_key'),
    logger: logger(),
    spawn: (_exe, args) => {
      spawns.push(args);
      if (args[0] === '--quit') world.up = false;
      if (args.includes('--pod-bootstrap')) {
        const req = JSON.parse(fs.readFileSync(args[args.indexOf('--pod-bootstrap') + 1] as string, 'utf8')) as { keyOut: string };
        if (opts.startsOnSpawn !== false) world.up = true;
        if (opts.issueKey) {
          fs.writeFileSync(req.keyOut, opts.issueKey);
          world.validKey = opts.issueKey;
        }
      }
    },
    fetch: async (url, init) => {
      if (!world.up) throw new Error('ECONNREFUSED');
      if (url.endsWith('/v1/health')) return { status: 200, json: async () => ({ ok: true, pod: world.pod }) };
      const auth = init?.headers?.Authorization;
      return { status: auth === `Bearer ${world.validKey}` ? 200 : 401, json: async () => ({}) };
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    startTimeoutMs: 10_000,
  };
  return { sup: new Muse4aiSupervisor(deps), spawns, secrets, world, workDir };
}

describe('Muse4aiSupervisor', () => {
  it('bundled copy already running with a working key: nothing is started', async () => {
    const r = rig({ up: true, validKey: 'msk_ok' });
    r.secrets.set('bridge_api_key', 'msk_ok');
    await r.sup.ensure();
    expect(r.sup.status().muse4ai).toBe('running');
    expect(r.spawns).toEqual([]);
  });

  it('not running: starts hidden with a bootstrap request, stores the handed-over key and removes the files', async () => {
    const r = rig({ up: false, issueKey: 'msk_new' });
    await r.sup.ensure();
    expect(r.sup.status().muse4ai).toBe('running');
    expect(r.spawns[0]?.slice(0, 2)).toEqual(['--hidden', '--pod-bootstrap']);
    expect(r.secrets.get('bridge_api_key')).toBe('msk_new');
    expect(fs.readdirSync(r.workDir)).toEqual([]);
  });

  it('running but POD lost its key: asks for a new one (rotateKey) through the running copy', async () => {
    const r = rig({ up: true, validKey: 'msk_old', issueKey: 'msk_rotated' });
    let request: { rotateKey?: boolean; proxyPort?: number } = {};
    const origSpawn = r.spawns.push.bind(r.spawns);
    r.spawns.push = (...items: string[][]) => {
      const args = items[0]!;
      if (args.includes('--pod-bootstrap')) request = JSON.parse(fs.readFileSync(args[args.indexOf('--pod-bootstrap') + 1] as string, 'utf8'));
      return origSpawn(...items);
    };
    await r.sup.ensure();
    expect(request).toMatchObject({ rotateKey: true, proxyPort: 8080 });
    expect(r.secrets.get('bridge_api_key')).toBe('msk_rotated');
    expect(r.sup.status().muse4ai).toBe('running');
  });

  it('another (unpatched) Muse4AI is running: reports outdated and starts nothing', async () => {
    const r = rig({ up: true, pod: false });
    await r.sup.ensure();
    expect(r.sup.status()).toMatchObject({ muse4ai: 'outdated' });
    expect(r.spawns).toEqual([]);
  });

  it('useBundled quits the other copy, then starts the bundled one', async () => {
    const r = rig({ up: true, pod: false, issueKey: 'msk_new' });
    await r.sup.ensure();
    expect(r.sup.status().muse4ai).toBe('outdated');
    // After --quit, the copy that starts is the bundled one (pod: true).
    r.world.pod = true;
    await r.sup.useBundled();
    expect(r.spawns[0]).toEqual(['--quit']);
    expect(r.spawns[1]?.slice(0, 2)).toEqual(['--hidden', '--pod-bootstrap']);
    expect(r.sup.status().muse4ai).toBe('running');
  });

  it('does not start within the timeout: failed with a safe message', async () => {
    const r = rig({ up: false, startsOnSpawn: false });
    await r.sup.ensure();
    expect(r.sup.status().muse4ai).toBe('failed');
    expect(r.sup.status().message).toMatch(/did not start/);
  });

  it('login opens the Muse4AI sign-in window', () => {
    const r = rig({});
    r.sup.login();
    expect(r.spawns).toEqual([['--pod-login']]);
  });

  it('concurrent ensure calls share one run', async () => {
    const r = rig({ up: false, issueKey: 'msk_new' });
    await Promise.all([r.sup.ensure(), r.sup.ensure()]);
    expect(r.spawns.filter((a) => a.includes('--pod-bootstrap'))).toHaveLength(1);
  });
});

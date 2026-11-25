// Builds the bundled Muse4AI used by POD Video Studio: pinned upstream commit + local patches.
// Usage: npm run build:muse4ai   → vendor/muse4ai/dist/ (packaged Windows app, gitignored)
// Nothing here is downloaded at app run time; this only runs on the build machine.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const upstream = Object.fromEntries(
  fs
    .readFileSync(path.join(here, 'UPSTREAM'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const work = path.join(here, '.work');
const desktop = path.join(work, 'desktop');
const dist = path.join(here, 'dist');
const skipTests = process.argv.includes('--skip-tests');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: cmd === npm && process.platform === 'win32' });
}

// 1. Pinned source (fresh every time so patches always apply to the exact commit).
fs.rmSync(work, { recursive: true, force: true });
run('git', ['-c', 'core.autocrlf=true', 'clone', '--quiet', upstream.repo, work], here);
run('git', ['-c', 'core.autocrlf=true', 'checkout', '--quiet', upstream.commit], work);

// 2. Local patches, in order.
const patches = fs.readdirSync(path.join(here, 'patches')).filter((f) => f.endsWith('.diff')).sort();
for (const p of patches) run('git', ['apply', '--ignore-whitespace', '--whitespace=nowarn', path.join(here, 'patches', p)], work);

// 3. Dependencies without install scripts, then the platform binary esbuild needs.
run(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], desktop);
run('node', ['node_modules/esbuild/install.js'], desktop);

// 4. Checks. One upstream test needs python3 on PATH; it is excluded only when python3 is missing.
run(npm, ['run', 'typecheck'], desktop);
if (!skipTests) {
  let hasPython = true;
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
  } catch {
    hasPython = false;
  }
  // A few upstream API tests are timing-sensitive on a busy machine; retry them instead of failing the build.
  const args = [path.join('node_modules', 'vitest', 'vitest.mjs'), 'run', '--retry=2'];
  if (!hasPython) args.push('-t', '^(?!.*standard unzip tool)');
  run('node', args, desktop);
}

// 5. Package and copy the app folder next to this script.
run(npm, ['run', 'package:win'], desktop);
const appDir = path.join(desktop, 'release', 'pkg', 'Muse4AI-win32-x64');
fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(appDir, dist, { recursive: true });
fs.copyFileSync(path.join(work, 'LICENSE'), path.join(dist, 'LICENSE.muse4ai.txt'));
fs.cpSync(path.join(desktop, 'LICENSES'), path.join(dist, 'LICENSES.muse4ai'), { recursive: true });
fs.writeFileSync(path.join(dist, 'POD-BUILD.txt'), `${upstream.repo}@${upstream.commit}\npatches: ${patches.join(', ')}\n`);
console.log(`Muse4AI bundled at ${dist}`);

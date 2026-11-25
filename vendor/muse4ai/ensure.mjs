// `npm run dist` guard: build the bundled Muse4AI once if vendor/muse4ai/dist is missing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
if (!fs.existsSync(path.join(here, 'dist', 'Muse4AI.exe'))) {
  execFileSync(process.execPath, [path.join(here, 'build.mjs')], { stdio: 'inherit' });
}

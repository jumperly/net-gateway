// The local helper as one executable for this OS: a Node single executable
// application (SEA). The helper is bundled into one CommonJS file (esbuild), Node turns it into a
// blob, and postject injects the blob into a copy of the running `node` binary.
//
//   pnpm build:helper
//   → dist/jumperly-helper(.exe), dist/jumperly-helper.cjs (the bundle, runs with plain `node`)
//
// A SEA is built for the OS and CPU of the `node` that runs this script: build each one on its own
// machine (or CI runner). The binary is unsigned; macOS gets an ad-hoc signature.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const bundle = join(dist, 'jumperly-helper.cjs');
const blob = join(dist, 'jumperly-helper.blob');
const exe = join(dist, process.platform === 'win32' ? 'jumperly-helper.exe' : 'jumperly-helper');
const seaConfig = join(dist, 'sea-config.json');
// The fuse every Node SEA binary carries (docs: "Single executable applications").
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, 'src/helper.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${process.versions.node.split('.')[0]}`,
  outfile: bundle,
  legalComments: 'linked',
  logLevel: 'warning',
});

writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }, null, 2),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

rmSync(exe, { force: true });
copyFileSync(process.execPath, exe);
if (process.platform === 'darwin')
  execFileSync('codesign', ['--remove-signature', exe], { stdio: 'inherit' });

const postject = require.resolve('postject/dist/cli.js');
execFileSync(
  process.execPath,
  [
    postject,
    exe,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    FUSE,
    ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
  ],
  { stdio: 'inherit' },
);
if (process.platform === 'darwin')
  execFileSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });

rmSync(blob, { force: true });
rmSync(seaConfig, { force: true });
console.log(`wrote ${exe}`);
